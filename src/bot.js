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
    trigger.map(e => this.slack.dms[e.channel]).where(channel => !!channel).do(channel => {
      channel.send(`Message to a channel to play avalon.`);
    }).subscribe();

    return trigger.map(e => {
      return {
        channel: this.slack.channels[e.channel] || this.slack.groups[e.channel],
        initiator: e.user
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
      .flatMap(starter => {
        this.isPolling = false;
        this.addBotPlayers(starter.players);
        
        return this.startGame(messages, starter.channel, starter.players);
      })
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
  pollPlayersForGame(messages, channel, initiator, specialChars, scheduler=rx.Scheduler.timeout, timeout=30) {
    this.isPolling = true;

    channel.send('Who wants to play Avalon? https://cf.geekdo-images.com/images/pic1398895_md.jpg');

    // let formatMessage = t => [
    //   'Respond with:',
    //   '\t`include percival,morgana,mordred,oberon,lady` to include special roles',
    //   '\t`add <player1>,<player2>` to add players',
    //   `\t\`yes\` to join${M.timer(t)}.`
    // ].join('\n');
    let formatMessage = t => `Respond with *'yes'* in this channel${M.timer(t)}.`;
    let timeExpired = PlayerInteraction.postMessageWithTimeout(channel, formatMessage, scheduler, timeout);

    // Look for messages containing the word 'yes' and map them to a unique
    // user ID, constrained to `maxPlayers` number of players.
    let pollPlayers = messages.where(e => e.text && e.text.toLowerCase().match(/\byes\b/))
      .map(e => e.user)
      .map(id => this.slack.getUserByID(id));
    timeExpired.connect();

    let addPlayers = messages//.where(e => e.user == initiator)
      .where(e => e.text && e.text.trim().match(/add /i))
      .map(e => e.text.split(/[,\s]+/).slice(1))
      .flatMap(playerNames => {
        let errors = [];
        let players = playerNames.map(name => {
          let player = this.slack.getUserByName(name.toLowerCase());
          if (!player) {
            errors.push(`Cannot find player ${name}`);
          }
          return player;
        }).filter(player => !!player);
        // players.add(this.slack.getUserById(id));
        if (errors.length) {
          channel.send(errors.join('\n'));
        }
        return rx.Observable.fromArray(players);
      })

    let newPlayerStream = rx.Observable.merge(pollPlayers, addPlayers)
      .takeUntil(timeExpired);

    return newPlayerStream.bufferWithTime(300)
      .reduce((players, newPlayers) => {
        if (newPlayers.length) {
          let messages = [];
          newPlayers = newPlayers.filter(player => {
            if (players.find(p => p.id == player.id)) {
              messages.push(`${M.formatAtUser(player)} has already joined`);
              return false;
            }
            return true;
          })
          players.splice.apply(players,[0,0].concat(newPlayers));
          messages = messages.concat(newPlayers.map(player => `${M.formatAtUser(player)} has joined the game`));
          if (players.length > 1 && players.length < Avalon.MAX_PLAYERS) {
            messages[messages.length - 1] += ` (${players.length} players in game so far)`;
          } else if (players.length == Avalon.MAX_PLAYERS) {
            messages[messages.length - 1] += ` (maximum ${players.length} players in game)`;
          }
          channel.send(messages.join('\n'));
        }
        return players;
      }, [])
      .map(players => { return{ channel: channel, players: players}})
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
      channel.send(`Not enough players for a game. Avalon requires ${Avalon.MIN_PLAYERS}-${Avalon.MAX_PLAYERS} players.`);
      return rx.Observable.return(null);
    }

    channel.send(`We've got ${players.length} players, let's start the game.`);
    this.isGameRunning = true;
    
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
