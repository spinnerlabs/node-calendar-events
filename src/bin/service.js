import {writeFileSync, readFileSync} from 'node:fs';
import {exec} from 'node:child_process';
import {google} from "googleapis";
import express from 'express';
import Player from "play-sound";
import notifier from "node-notifier";
import { SysTray } from 'node-systray-v2';
// Read env with dotenv.
import dotenv from 'dotenv';

dotenv.config();

const server = express();
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary'; // 'robert@spinnerlabs.no';

if (!clientId || !clientSecret) {
  console.error('Missing Google client id or secret.');
  process.exit(1);
}

const player = new Player();

const trayIcon = readFileSync('data/299092_calendar_icon.png').toString('base64');
let systray = null;

function formatDate(ymd) {
  const parts = ymd.split('-');
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function getTrayItems() {
  // Update the tray.
  const trayItems = [];

  const sortedEvents = events.sort((a, b) => {
    const aDate = new Date(a.start.dateTime || a.start.date);
    const bDate = new Date(b.start.dateTime || b.start.date);

    return aDate.getTime() - bDate.getTime();
  });

  sortedEvents.forEach((event) => {
    if (!event.start.dateTime) {
      return; // Skip all-day events.
    }

    const date = new Date(event.start.dateTime);
    const dateYmd = date.toISOString().split('T')[0];
    const time = date.toTimeString().split(' ')[0].slice(0, 5);
    const endDate = new Date(event.end.dateTime);
    const endYmd = endDate.toISOString().split('T')[0];
    const endTime = endDate.toTimeString().split(' ')[0].slice(0, 5);
    const dateDmY = formatDate(dateYmd);
    const endDmY = formatDate(endYmd);
    const endPart = endYmd === dateYmd ? '' : ` ${endDmY}`;


    trayItems.push({
      title: `${dateDmY} ${time} -${endPart} ${endTime}: ${event.summary}`,
      tooltip: `${event.etag}`,
      // checked is implement by plain text in linux
      checked: false,
      enabled: true,
    });
  });

  return trayItems;
}

function drawSysTray() {
  if (systray) {
    systray.kill();
  }

  systray = new SysTray({
    menu: {
      // you should using .png icon in macOS/Linux, but .ico format in windows
      icon: trayIcon,
      title: 'Node Calendar Events',
      tooltip: 'Node Calendar Events',
      items: getTrayItems(),
    },
    debug: false,
    copyDir: true, // copy go tray binary to outside directory, useful for packing tool like pkg.
  });

  systray.onClick((action) => {
    const event = events.find((e) => e.etag === action.item.tooltip);

    if (!event) {
      return;
    }

    // Try find 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZjM4N2ZhZmMtMWZiZi00NzQ0LWI4YzEtMTY2ODA0NTA2OGM3%40thread.v2/0?context=%7b%22Tid%22%3a%227eca4465-b4ab-49af-9230-bb95171ed47b%22%2c%22Oid%22%3a%223220e9af-596e-440f-bb94-f69a14229ab9%22%7d' in
    // the description and open it.
    const description = event.description || '';
    const teamsLinkMatch = description.match(/<(https:\/\/teams\.microsoft\.com\/l\/meetup-join\/.*)>/);

    if (teamsLinkMatch) {
      exec(`open "${teamsLinkMatch[1]}"`);
      return;
    } else {
      console.log('No teams link found in description.', event);
    }

    const googleMeetMatch = description.match(/<(https:\/\/meet\.google\.com\/.*)>/);

    if (googleMeetMatch) {
      exec(`open "${googleMeetMatch[1]}"`);
      return;
    }

    // Open the htmlLink.
    exec(`open ${event.htmlLink}`);
  });
}

function loadTokens(forceLogin = false) {
  if (forceLogin) {
    return {
      access_token: null,
      refresh_token: null,
    };
  }

  try {
    return JSON.parse(readFileSync('tokens.json').toString());
  } catch (e) {
    return {
      access_token: null,
      refresh_token: null,
    };
  }
}

const argv = process.argv.slice(2);
const forceLogin = argv.includes('--login');
const refresh = argv.includes('--refresh');

const auth = loadTokens(forceLogin);

function loadEvents() {
  try {
    return JSON.parse(readFileSync('events.json').toString());
  } catch (e) {
    return [];
  }
}

function saveEvents() {
  writeFileSync('events.json', JSON.stringify(events));
}

const events = auth.access_token && !refresh? loadEvents() : [];
const ignoredEvents = new Map();
const notifiedKeys = new Map();

// Konfigurer OAuth2-klienten med dine egne detaljer
const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  'http://localhost:9080/oauth2callback');

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

server.get('/oauth2callback', (req, res) => {
  const data = req.query;

  console.debug(data);

  const { code, scope } = data;

  if (!code) {
    res.status(400).send('No code provided');
    return;
  }

  oauth2Client.getToken(code, (err, tokens) => {
    if (err) {
      console.error('Error while trying to retrieve access token', err);
      return;
    }

    oauth2Client.setCredentials(tokens);

    // Save these tokens for later.
    writeFileSync('tokens.json', JSON.stringify(tokens));
    auth.access_token = tokens.access_token;
    auth.refresh_token = tokens.refresh_token;

    refreshEvents();
  });

  res.status(200).send('OK. You are now logged in.');
});

oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token) {
    console.log('Refresh token:', tokens.refresh_token);
  }

  console.log('Access token:', tokens.access_token);
  console.log('Token expiry:', tokens.expiry_date);
});

server.listen(9080);

if (auth.access_token === null) {
  authorize();
} else {
  oauth2Client.setCredentials(auth);
  refreshEvents();
}

setInterval(() => {
  refreshEvents();
}, 1000 * 60 * 5);

// Every minute, check for events that start the next 5 minutes.
setInterval(() => {
  checkEvents();
}, 1000 * 30);

drawSysTray();
checkEvents();

function checkEvents() {
  const now = new Date();

  for (const event of events) {
    if (!event.start.dateTime) {
      continue; // Skip all-day events.
    }

    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);
    const minutesToStart = Math.floor((start - now) / 1000 / 60);

    if (minutesToStart <= 5 && end > now && !ignoredEvents.has(event.id)) {
      console.log('Event starting soon:', event.summary, minutesToStart);

      let title = 'Event';
      let sound = 'data/234563__foolboymedia__notification-up-ii.wav';
      let cacheId = 1;

      if (minutesToStart <= 0) {
        title = 'Event started';
        sound = 'data/457518__graham_makes__chord-alert-notification.wav';
        cacheId = 1;
      } else if (minutesToStart <= 1) {
        title = 'Event starting now';
        cacheId = 2;
      } else if (minutesToStart < 5) {
        title = `Event starting in ${minutesToStart} minutes`;
        sound = 'data/716448__scottyd0es__tone12_msg_notification_2.wav';
        cacheId = 3;
      }

      const cacheKey = `${event.etag}-${sound}-${cacheId}`;

      if (notifiedKeys.has(cacheKey)) {
        continue;
      }

      console.info('Notifying about event:', event.summary, title);

      const startTime = start.toTimeString().split(' ')[0].slice(0, 5);
      const endTime = end.toTimeString().split(' ')[0].slice(0, 5);
      notifier.notify({
        title: `${startTime} - ${endTime}: ${title}`,
        message: `${event.location || ''} ${event.summary}`,
      });

      player.play(sound, { timeout: 2500 }, function (err) {
        console.error(err);
      });

      notifiedKeys.set(cacheKey, true);
    }
  }
}

function authorize() {
  // Generer URL for å autentisere brukeren
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly']
  });

  console.log('Åpne denne URL-en i nettleseren din:', url);

  // Notify about it.
  notifier.notify({
    title: 'Node calendar events',
    message: 'Authorize the app by visiting the URL in the console.',
    wait: true,
  });

  notifier.on('click', function (notifierObject, options, event) {
    // Open the url in the default browser
    exec(`open ${url}`);
  });
}

function refreshEvents() {
  console.info('Refreshing events');

  calendar.events.list({
    calendarId, // eller en spesifikk kalender-ID
    timeMin: (new Date()).toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime'
  }, (err, res) => {
    if (err) {
      console.error('Feil ved henting av hendelser:', err);

      // Notify about it.
      notifier.notify({
        title: 'Error while fetching events',
        message: err.message,
      });

      // TODO: Should update the tray.

      return;
    }

    const newEvents = [];
    let hasChanges = false;

    // Mark new ones.
    res.data.items.forEach((event) => {
      // If it doesn't already exist add it to events.
      if (!events.find((e) => e.id === event.id)) {
        newEvents.push(event);
        hasChanges = true;
      }
    });

    if (newEvents.length > 0) {
      console.log('Events:', newEvents.map((e) => e.summary).join(', '));
      // Notify about it.
      notifier.notify({
        title: 'New events fetched',
        message: newEvents.map((e) => e.summary).join(', '),
      });

      hasChanges = true;
    }

    if (newEvents.length !== events.length) {
      hasChanges = true;
    }

    const previousEvents = JSON.parse(JSON.stringify(events));

    // Remove all events
    events.splice(0, events.length);

    // Add back.
    events.push(...res.data.items);

    // Check if there are any events that are removed.
    for (const event of previousEvents) {
      const found = events.find((e) => e.id === event.id);
      const eventIsInTheFuture = new Date(event.start.dateTime) > new Date();

      if (!found && eventIsInTheFuture && !ignoredEvents.has(event.id)) {
        console.info('Event removed:', event.summary);
        hasChanges = true;

        // Notify about it.
        notifier.notify({
          title: 'Event removed',
          message: event.summary,
        });
      }
    }

    if (hasChanges) {
      drawSysTray();
      checkEvents();
      saveEvents();
    }
  });
}
