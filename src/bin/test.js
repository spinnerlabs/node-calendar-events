import Player from 'play-sound'
/*
const player = new Player();

player.play('data/234563__foolboymedia__notification-up-ii.wav', { timeout: 1400 }, function(err){
  if (err) throw err
});*/

import notifier from "node-notifier";

notifier.notify({
  title: 'My notification',
  message: 'Hello, there!'
});