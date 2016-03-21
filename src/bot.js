const rx = require('rx');
const _ = require('lodash');

const Slack = require('slack-client');
const SlackApiRx = require('./slack-api-rx');
//const TexasHoldem = require('./texas-holdem');
//const ChinesePoker = require('./chinese-poker');
const M = require('./message-helpers');
const PlayerInteraction = require('./player-interaction');
const Avalon = require('./avalon');

const WeakBot = require('../ai/weak-bot');
const AggroBot = require('../ai/aggro-bot');

class Bot {
  // Public: Creates a new instance of the bot.
  //
  // token - An API token from the bot integration
  constructor(token) {
    this.slack = new Slack(token, true, true);
    
    this.gameConfig = {};
    this.gameConfigParams = ['timeout'];
  }

  // Public: Brings this bot online and starts handling messages sent to it.
  login() {
    rx.Observable.fromEvent(this.slack, 'open')
      .subscribe(() => this.onClientOpened());

    this.slack.login();
    this.respondToMessages();
  }

  // Private: Listens for messages directed at this bot that contain the word
  // 'deal,' and poll players in response.
  //
  // Returns a {Disposable} that will end this subscription
  respondToMessages() {
    let messages = rx.Observable.fromEvent(this.slack, 'message')
      .where(e => e.type === 'message');

    let atMentions = messages.where(e => 
      M.containsUserMention(e.text, this.slack.self.id));

    let disp = new rx.CompositeDisposable();
        
    disp.add(this.handleDealGameMessages(messages, atMentions));
    disp.add(this.handleConfigMessages(atMentions));
    
    return disp;
  }
  
  // Private: Looks for messages directed at the bot that contain the word
  // "deal." When found, start polling players for a game.
  //
  // messages - An {Observable} representing messages posted to a channel
  // atMentions - An {Observable} representing messages directed at the bot
  //
  // Returns a {Disposable} that will end this subscription
  handleDealGameMessages(messages, atMentions) {
    let trigger = messages.where(e => e.text && e.text.toLowerCase().match(/^play avalon/i));
    let dmStart = trigger.where(e => !!this.slack.dms[e.channel]).map(e => e.text.split(/[,\s]+/).slice(2))
      .map(playerNames => {
        let channel = this.slack.dms[e.channel];
        if (this.isPolling) {
          channel.send(`Another game is polling in a different channel`);
          return [];
        } else if (this.isGameRunning) {
          channel.send('Another game is in progress, quit that first.');
          return [];
        }
        let errors = [];
        let players = playerNames.map(name => {
          let player = this.slack.getUserByName(name);
          if (!player) {
            errors.push(`Cannot find player ${name}`);
          }
          return player;
        });
        if (!playerNames.length) {
          errors.push(`Usage: \`play avalon <player1> <player2> ...\``);
        } else if (players.length < 5 || players.length > 10) {
          errors.push(`Avalon is requires 5-10 players. You've inputed ${players.length} valid players.`)
        }
        if (errors.length) {
          channel.send(errors.join('\n'));
        }
        return players;
      })
      .where(players => players.length >= 5 && players.length <= 10);


    let groupStart = trigger.map(e => {
      return {
        channel: this.slack.channels[e.channel] || this.slack.groups[e.channel],
        initiator: e.user,
        playerNames: e.text.split(/[,\s]+/).slice(2)
      };
    }).where(starter => !!starter.channel)
      .where(starter => {
        if (this.isPolling) {
          return false;
        } else if (this.isGameRunning) {
          starter.channel.send('Another game is in progress, quit that first.');
          return false;
        }
        return true;
      })
      .flatMap(starter => this.pollPlayersForGame(messages, starter.channel, starter.initiator, starter.playerNames))

    let startGame =
      .subscribe();
  }
  
  // Private: Looks for messages directed at the bot that contain the word
  // "config" and have valid parameters. When found, set the parameter.
  //
  // atMentions - An {Observable} representing messages directed at the bot
  //
  // Returns a {Disposable} that will end this subscription
  handleConfigMessages(atMentions) {
    return atMentions
      .where(e => e.text && e.text.toLowerCase().includes('config'))
      .subscribe(e => {
        let channel = this.slack.getChannelGroupOrDMByID(e.channel);
        
        e.text.replace(/(\w*)=(\d*)/g, (match, key, value) => {
          if (this.gameConfigParams.indexOf(key) > -1 && value) {
            this.gameConfig[key] = value;
            channel.send(`Game ${key} has been set to ${value}.`);
          }
        });
      });
  }
  
  // Private: Polls players to join the game, and if we have enough, starts an
  // instance.
  //
  // messages - An {Observable} representing messages posted to the channel
  // channel - The channel where the deal message was posted
  //
  // Returns an {Observable} that signals completion of the game 
  pollPlayersForGame(messages, channel, initiator, playerNames) {
    this.isPolling = true;

    let errors = [];
    let players = playerNames.map(name => {
      let player = this.slack.getUserByName(name);
      if (!player) {
        errors.push(`Cannot find player ${name}`);
      }
      return player;
    });
    if (errors.length) {
      channel.send(errors.join('\n'));
    }
    players.unshift(this.slack.getUserByID(initiator));

    let fromPoll = PlayerInteraction.pollPotentialPlayers(messages, channel)
      .map(id => this.slack.getUserByID(id));
    let fromCmd = Rx.Observable.fromArray(players);
    let newPlayerStream = Rx.Observable.merge(fromPoll, fromCmd).distinct(player => player.id);

    return newPlayerStream.buffer(newPlayerStream.debounce(1000))
      .reduce((players, newPlayers) => {
        players.apply(players,[0,0].concat(newPlayers));
        let messages = newPlayers.map(player => `${M.formatAtUser(player)} has joined the game`);
        if (players.length > 1) {
          messages[messages.length - 1] += ` (${players.length} players in game so far)`;
        }
        channel.send(messages.join('\n'));
        return players;
      }, [])
      .flatMap(players => {
        this.isPolling = false;
        this.addBotPlayers(players);
        
        return this.startGame(messages, channel, players);
      });
  }

  // Private: Starts and manages a new Chinese Poker game.
  //
  // messages - An {Observable} representing messages posted to the channel
  // channel - The channel where the game will be played
  // players - The players participating in the game
  //
  // Returns an {Observable} that signals completion of the game 
  startGame(messages, channel, players) {
    if (players.length < Avalon.MIN_PLAYERS) {
      channel.send('Not enough players for a game. Avalon requires 5-10 players.');
      return rx.Observable.return(null);
    }

    channel.send(`We've got ${players.length} players, let's start the game.`);
    this.isGameRunning = true;
    
    //let game = new TexasHoldem(this.slack, messages, channel, players);
    let game = new Avalon(this.slack, messages, channel, players);
    _.extend(game, this.gameConfig);

    // Listen for messages directed at the bot containing 'quit game.'
    let quitGameDisp = messages.where(e => e.text && e.text.match(/^quit game/i))
      .take(1)
      .subscribe(e => {
        // TODO: Should poll players to make sure they all want to quit.
        let player = this.slack.getUserByID(e.user);
        channel.send(`${M.formatAtUser(player)} has decided to quit the game.`);
        game.endGame(`${M.formatAtUser(player)} has decided to quit the game.`);
      });
    
    return SlackApiRx.openDms(this.slack, players)
      .flatMap(playerDms => rx.Observable.timer(2000)
        .flatMap(() => game.start(playerDms)))
      .do(() => {
        quitGameDisp.dispose();
        this.isGameRunning = false;
      });
  }

  // Private: Adds AI-based players (primarily for testing purposes).
  //
  // players - The players participating in the game
  addBotPlayers(players) {
    //let bot1 = new WeakBot('Phil Hellmuth');
    //players.push(bot1);
    
    //let bot2 = new AggroBot('Phil Ivey');
    //players.push(bot2);
  }

  // Private: Save which channels and groups this bot is in and log them.
  onClientOpened() {
    this.channels = _.keys(this.slack.channels)
      .map(k => this.slack.channels[k])
      .filter(c => c.is_member);

    this.groups = _.keys(this.slack.groups)
      .map(k => this.slack.groups[k])
      .filter(g => g.is_open && !g.is_archived);
      
    this.dms = _.keys(this.slack.dms)
      .map(k => this.slack.dms[k])
      .filter(dm => dm.is_open);

    console.log(`Welcome to Slack. You are ${this.slack.self.name} of ${this.slack.team.name}`);

    if (this.channels.length > 0) {
      console.log(`You are in: ${this.channels.map(c => c.name).join(', ')}`);
    } else {
      console.log('You are not in any channels.');
    }

    if (this.groups.length > 0) {
      console.log(`As well as: ${this.groups.map(g => g.name).join(', ')}`);
    }
    
    if (this.dms.length > 0) {
      console.log(`Your open DM's: ${this.dms.map(dm => dm.name).join(', ')}`);
    }
  }
}

module.exports = Bot;
