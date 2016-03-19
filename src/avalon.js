const rx = require('rx');
const _ = require('lodash');
const SlackApiRx = require('./slack-api-rx');
const PlayerInteraction = require('./player-interaction');
const M = require('./message-helpers');

rx.config.longStackSupport = true;

const ROLE = {
  'bad': ':red_circle: Minion of Mordred',
  'good': ':large_blue_circle: Loyal Servent of Arthur',
  'assassin': ':crossed_swords: THE ASSASSIN :red_circle: Minion of Mordred',
  'merlin': ':angel: MERLIN :blue_circle: Loyal Servent of Arthur'
};
const ROLE_ASSIGNS = [
  ['bad', 'good'],
  ['assassin', 'good', 'merlin'],
  ['assassin', 'good', 'good', 'merlin'],
  ['bad', 'assassin', 'good', 'good', 'merlin'],
  ['bad', 'assassin', 'good', 'good', 'good', 'merlin'],
  ['bad', 'bad', 'assassin', 'good', 'good', 'good', 'merlin'],
  ['bad', 'bad', 'assassin', 'good', 'good', 'good', 'good', 'merlin'],
  ['bad', 'bad', 'assassin', 'good', 'good', 'good', 'good', 'good', 'merlin'],
  ['bad', 'bad', 'bad', 'assassin', 'good', 'good', 'good', 'good', 'good', 'merlin']
];

const ORDER = ['first', 'second', 'third', 'fourth', 'last'];

const QUEST_ASSIGNS = [
  [{n:2,f:1},{n:1,f:1},{n:2,f:1},{n:1,f:1},{n:2,f:1}],
  [{n:2,f:1},{n:2,f:1},{n:2,f:1},{n:2,f:1},{n:2,f:1}],
  [{n:2,f:1},{n:3,f:1},{n:2,f:1},{n:3,f:1},{n:3,f:1}],
  [{n:2,f:1},{n:3,f:1},{n:2,f:1},{n:3,f:1},{n:3,f:1}],
  [{n:2,f:1},{n:3,f:1},{n:3,f:1},{n:3,f:1},{n:4,f:1}],
  [{n:2,f:1},{n:3,f:1},{n:3,f:1},{n:4,f:2},{n:4,f:1}],
  [{n:3,f:1},{n:4,f:1},{n:4,f:1},{n:5,f:2},{n:5,f:1}],
  [{n:3,f:1},{n:4,f:1},{n:4,f:1},{n:5,f:2},{n:5,f:1}],
  [{n:3,f:1},{n:4,f:1},{n:4,f:1},{n:5,f:2},{n:5,f:1}]
];

class Avalon {
  constructor(slack, messages, channel, players, scheduler=rx.Scheduler.timeout) {
    this.slack = slack;
    this.messages = messages;
    this.channel = channel;
    this.players = players;
    this.scheduler = scheduler;
    this.gameEnded = new rx.Subject();
  }

  start(playerDms, timeBetweenRounds=1000) {
    this.isRunning = true;
    this.questNumber = 0;
    this.rejectCount = 0;
    this.progress = [];
    this.playerDms = playerDms;

    let assigns = _.shuffle(ROLE_ASSIGNS[this.players.length - 2]);
    let players = _.shuffle(this.players);
    this.players = players;

    let evils = this.evils = [];
    for (let i=0; i < players.length; i++) {
      let player = players[i];
      player.role = assigns[i];
      if (player.role == 'assassin' || player.role == 'bad') {
        evils.push(player.name);
      }
    }

    for (let player of this.players) {
      let message = 'You are ' + ROLE[player.role];
      if (player.role != 'good') {
        message += '. ' + evils.join() + ' are evil';
      }
      this.dm(player,message)
    }

    rx.Observable.return(true)
      .flatMap(() => this.playRound()
        .flatMap(() => rx.Observable.timer(timeBetweenRounds, this.scheduler)))
      .repeat()
      .takeUntil(this.gameEnded)
      .subscribe();
      
    return this.gameEnded;
  }

  quit() {
    this.gameEnded.onNext(true);
    this.gameEnded.onCompleted();
    this.isRunning = false;
  }

  playRound() {
    let roundEnded = new rx.Subject();
    let queryPlayers = rx.Observable.fromArray(this.players)
      .concatMap(player => this.deferredActionForPlayer(player, roundEnded))
      //.concatMap(player => this.autoFlop(player, roundEnded))
      .repeat()
      .takeUntil(this.gameEnded)
      .publish();

    queryPlayers.connect();
    roundEnded.subscribe(this.endRound.bind(this));
    return roundEnded;
  }

  endRound() {

  }

  dm(player, message) {
    return this.playerDms[player.id].send(message);
  }

  dmMessages(player) {
    return this.messages.where(e => e.channel == this.playerDms[player.id].id);
  }

  questAssign() {
    return QUEST_ASSIGNS[this.players.length-2][this.questNumber];
  }

  deferredActionForPlayer(player, roundEnded, timeToPause=1000) {
    return rx.Observable.defer(() => {
      return rx.Observable.timer(timeToPause, this.scheduler).flatMap(() => {
        let questAssign = this.questAssign();
        let f = '';
        if (questAssign.f > 1) {
          f = ' (2 fails required)';
        }
        let message = ` ${questAssign.n} players ${f}to go on the ${ORDER[this.questNumber]} quest.`;
        let status = `Quest progress: ${this.getStatus(true)}\n`;
        for (let p of this.players) {
          if (p.id == player.id) {
            this.dm(p,`${status}*You* choose${message}\n(.eg \`send name1, name2\`)`)
          } else {
            this.dm(p,`${status}${M.formatAtUser(player)} chooses${message}`)
          }
        }
        return this.choosePlayersForQuest(player, roundEnded)
          .concatMap(votes => {
            let printQuesters = this.pp(this.questPlayers);
            if (votes.approved.length >= votes.rejected.length) {
              this.broadcast(`The ${ORDER[this.questNumber]} quest with ${printQuesters} going was approved by ${this.pp(votes.approved)}`)
              this.rejectCount = 0;
              return rx.Observable.defer(() => rx.Observable.timer(timeToPause, this.scheduler).flatMap(() => {
                return this.runQuest(this.questPlayers, roundEnded);
              }));
            }
            this.rejectCount++;
            this.broadcast(`The ${ORDER[this.questNumber]} quest with ${printQuesters} going was rejected (${this.rejectCount}) by ${this.pp(votes.rejected)}`)
            return rx.Observable.return(true);
          })
      });
    });
  }

  broadcast(message) {
    for (let player of this.players) {
      this.dm(player, message);
    }
  }

  pp(arrayOfPlayers) {
    return arrayOfPlayers.map(p => M.formatAtUser(p)).join(',');
  }

  choosePlayersForQuest(player, roundEnded) {
    let questAssign = this.questAssign();
    return this.messages
      .where(e => e.user === player.id)
      .map(e => e.text)
      .where(text => text && text.match(/^send /i))
      .map(text => text.split(/[,\s]+/).slice(1))
      .map(chosen => {
        if (chosen.length != questAssign.n) {
          return [];
        }
        let questPlayers = [];
        for (let p of this.players) {
          if (chosen.some(name => name == p.name)) {
            questPlayers.push(p);
          }
        }
        return questPlayers;
      })
      .where(questPlayers => {
        if (questPlayers.length != questAssign.n) {
          this.dm(player, `You need to send ${questAssign.n} players. (You only chosen ${questPlayers.length} valid players)`);
        }
        return questPlayers.length == questAssign.n;
      })
      .concatMap(questPlayers => {
        this.questPlayers = questPlayers;
        let printPlayers = questPlayers.map(qp => qp.name).join(', ');
        this.dm(player, `You've chosen ${printPlayers} to go on the ${ORDER[this.questNumber]} quest. Awaiting votes...`);
        return rx.Observable.fromArray(this.players.filter(p => p.id != player.id))
          .map(p => {
            this.dm(p, `${M.formatAtUser(player)} is sending ${printPlayers} to the ${ORDER[this.questNumber]} quest.\nVote *approve* or *reject*`);
            return this.dmMessages(p)
              .where(e => e.user === p.id)
              .map(e => e.text)
              .where(text => text && text.match(/^\b(approve|reject)\b$/))
              .map(text => { return { player: p, approve: text.match(/approve/) }})
              .take(1)
          }).mergeAll()
          
      })
      .take(this.players.length - 1)
      .reduce((acc, vote) => {
        if (vote.approve) {
          acc.approved.push(vote.player);
        } else {
          acc.rejected.push(vote.player);
        }
        return acc;
      }, { approved: [], rejected: [] })
  }

  getStatus(current = false) {
    let status = this.progress.map((res,i) => {
      let questAssign = QUEST_ASSIGNS[this.players.length-2][i];
      let circle = res == 'good' ? ':large_blue_circle:': ':red_circle:';
      return `${questAssign.n}${questAssign.f > 1 ? '*' : ''}${circle}`;
    });
    if (current) {
      let questAssign = QUEST_ASSIGNS[this.players.length-2][this.questNumber];
      status.push(`${questAssign.n}${questAssign.f > 1 ? '*' : ''}:black_circle:`);
    }
    if (status.length < 5) {
      status = status.concat(_.times(5 - status.length, (i) => {
        let questAssign = QUEST_ASSIGNS[this.players.length-2][i + status.length];
        return `${questAssign.n}${questAssign.f > 1 ? '*' : ''}:white_circle:`;
      }));
    }
    return status.join(',');
  }

  runQuest(questPlayers, roundEnded) {
    let message = `${this.pp(questPlayers)} are going on the ${ORDER[this.questNumber]} quest.`
    message += `\nCurrent quest progress: ${this.getStatus(true)}`;
    for (let player of this.players) {
      if (questPlayers.some(p => p.name == player.name)) {
        this.dm(player, `${message}\nYou can *succeed* or *fail* for this mission`)
      } else {
        this.dm(player, `${message}\nWait for the quest results.`);
      }
    }
    try {
    let runners = 0;
    return rx.Observable.fromArray(questPlayers)
      .map(player => {
        return this.dmMessages(player)
          .where(e => e.user === player.id)
          .map(e => e.text)
          .where(text => text && text.match(/^\b(succeed|fail)\b$/))
          .map(text => text.match(/fail/) ? 1 : 0)
          .take(1)
      }).mergeAll()
      .do(() => {
        if (++runners < questPlayers.length) {
          this.broadcast(`${runners} out of ${questPlayers.length} completed the quest`);
        }
      })
      .take(questPlayers.length)
      .reduce((acc, fail) => acc + fail,0)
      .map((fails) => {
        let message;
        if (fails > 0) {
          this.progress.push('bad');
          message = `${fails} in (${this.pp(questPlayers)}) failed the ${ORDER[this.questNumber]} quest!`;
        } else {
          this.progress.push('good')
          message = `${this.pp(questPlayers)} succeeded the ${ORDER[this.questNumber]} quest!`;
        }
        this.broadcast(message);
        let score = { good: 0, bad: 0 };
        for (let res of this.progress) {
          score[res]++;
        }
        return score;
      })
      .concatMap(score => {
        let message;
        if (score.bad == 3) {
          message = `:red_circle: Minions of Mordred win by failing 3 quests!`;
          let merlin = this.players.filter(player => player.role == 'merlin');
          message += `\n${this.evil.join(',')} are :red_circle: Minions of Mordred.`;
          if (merlin.length) {
            message += `\n${merlin[0].name} is :angel: Merlin`;
          }
          this.broadcast(message);
          this.gameEnded.onNext(true);
          this.gameEnded.onCompleted();
        } else if (score.good == 3) {
          let assassin = this.players.filter(player => player.role == 'assassin');
          if (!assassin.length) {
            message = `:large_blue_circle: Loyal Servents of Arthur win by succeeding 3 quests!`;
            message += `\n${this.evil.join(',')} are :red_circle: Minions of Mordred.`;
            this.broadcast(message);
            this.gameEnded.onNext(true);
            this.gameEnded.onCompleted();
            return rx.Observable.return(true);
          }
          let merlin = this.players.filter(player => player.role == 'merlin')[0];
          assassin = assasin[0];
          this.broadcast(`Victory is near for :large_blue_circle: Loyal Servents of Arthur for succeeding 3 quests!`);
          return rx.Observable.defer(() => {
            return rx.Observable.timer(1000, this.scheduler).flatMap(() => {
              for (let player of this.players) {
                if (player.id == assassin.id) {
                  this.dm(player, `*You* are the :red_circle: assassin. Type \`kill <player>\` to attempt to kill Merlin`);
                } else {
                  this.dm(player, `*@${assassin.name}* is the :red_circle: assassin. Awaiting the Merlin assassination attempt...`);
                }
              }
              return this.messages
                .where(e => e.user === assassin.id)
                .map(e => e.text)
                .map(text => text && text.match(/^\bkill\b (.+)/))
                .where(match => match && match[1])
                .map(match => {
                  let accused = this.players.filter(player => player.name == match[1]);
                  if (!accused.length) {
                    this.dm(assassin, `${match[1]} is not a valid player`);
                    return null;
                  }
                  return accused[1];
                })
                .where(accused => !!accused)
                .take(1)
                .do(accused => {
                  if (accused.role != 'merlin') {
                    for (let player of this.players) {
                      if (player.id == assassin.id) {
                        this.dm(player, `@${accused.name} is not Merlin. :angel:@${merlin.name} is. :large_blue_circle: Loyal Servants of Arthur win!`);
                      } else {
                        this.dm(player, `:crossed_swords:@${assassin.name} chose @${accuse.name} as Merlin, not :angel:${merlin.name}. :large_blue_circle: Loyal Servants of Arthur win!`);
                      }
                    }
                  } else {
                    for (let player of this.players) {
                      if (player.id == assassin.id) {
                        this.dm(player, `You chose :angel:@${accused.name} correctly as Merlin. :red_circle: Minions of Mordred win!`);
                      } else {
                        this.dm(player, `:crossed_swords:@${assassin.name} chose :angel:@${accused.name} correctly as Merlin. :red_circle: Minions of Mordred win!`);
                      }
                    }
                  }
                  this.gameEnded.onNext(true);
                  this.gameEnded.onCompleted();
                })
            });
          });
        }
        return rx.Observable.return(true);
      })
    } catch(e) { console.error('ee', e)}
  }
}

module.exports = Avalon;