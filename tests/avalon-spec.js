require('babel/register');

const rx = require('rx');
const _ = require('lodash');
const assert = require('chai').assert;

const Avalon = require('../src/avalon');

describe('Avalon', function() {
  var game, slack, messages, channel, scheduler, players, playerDms;

  beforeEach(function() {
    slack = { token: 0xDEADBEEF };
    messages = new rx.Subject();
    channel = {
      send: function(message) {
        console.log(message);
        return { updateMessage: function() { } };
      }
    };
    messages.subscribe(m => {
      if (m.user && m.text) {
        console.log(`${players.find(p => p.id == m.user).name}: ${m.text}`);
      }
    });
    
    scheduler = new rx.HistoricalScheduler();
    players = [
      { id: 1, name: 'player_1' },
      { id: 2, name: 'player_2' },
      { id: 3, name: 'player_3' },
      { id: 4, name: 'player_4' },
      { id: 5, name: 'player_5' }
    ];

    game = new Avalon(slack, messages, channel, players, scheduler);
    var logFunc = (method, id) => {
      return (msg => console.log(`${method}(${id}): ${msg}`));
    };
    playerDms = {
      1: { send: logFunc('send',1), postMessage: logFunc('postMessage', 1) },
      2: { send: logFunc('send',2), postMessage: logFunc('postMessage', 2) },
      3: { send: logFunc('send',3), postMessage: logFunc('postMessage', 3) },
      4: { send: logFunc('send',4), postMessage: logFunc('postMessage', 4) },
      5: { send: logFunc('send',5), postMessage: logFunc('postMessage', 5) }
    };
  });
  
  it('check standard game', function() {
    game.start(playerDms, 0);

    scheduler.advanceBy(1000);
    messages.onNext({user: 1, text: 'send player_1, player_2, player_3'});
  });
});