import Player from 'play-sound'

const player = new Player();

player.play('data/716448__scottyd0es__tone12_msg_notification_2.wav', { timeout: 1400 }, function(err){
  if (err) throw err
});

/*import notifier from "node-notifier";

notifier.notify({
  title: 'My notification',
  message: 'Hello, there!'
});*/