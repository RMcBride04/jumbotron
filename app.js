// Jumbotron: gets scores, flips through pages of games, and runs the scrolling strip.
(function () {
  'use strict';

  // ----- Settings you might want to change -----
  var PAGE_SECONDS = 15;        // how long each page of games stays up
  var CARDS_PER_PAGE = 4;       // matches the 2 x 2 layout in style.css
  var MAX_UPCOMING = 24;        // most upcoming games to list in the strip
  var UPCOMING_HOURS = 48;      // ignore games further away than this
  var IDLE_SECONDS = 120;       // how often to check a league with no live games
  var RETRY_SECONDS = 30;       // how soon to retry after a failed request
  var NEWS_SECONDS = 900;       // how often to get new headlines
  var HEADLINE_EVERY = 5;       // one headline after this many scores in the strip
  var STRIP_SPEED = 0.055;      // strip speed, as a share of screen width per second
  var ALERT_SECONDS = 8;        // how long a touchdown or red-zone banner stays up
  var MAX_ALERTS_WAITING = 5;   // banners beyond this are skipped so they never pile up
  var RED_ZONE_REPEAT_SECONDS = 180; // won't repeat a red-zone banner for the same drive

  // Which player stats each sport lists in the panel.
  var FOOTBALL_STATS = [
    { name: 'passingYards', label: 'PASS' },
    { name: 'rushingYards', label: 'RUSH' },
    { name: 'receivingYards', label: 'REC' }
  ];
  var BASKETBALL_STATS = [
    { name: 'points', label: 'PTS' },
    { name: 'rebounds', label: 'REB' },
    { name: 'assists', label: 'AST' }
  ];
  var BASEBALL_STATS = [{ name: 'MLBRating', label: 'TOP', count: 3 }];

  // What counts as a close game: in this period or later, with this much or
  // less on the clock (in seconds, if given), and a score this tight.
  var FOOTBALL_CLOSE = { period: 4, margin: 8 };

  // featured: shown ahead of every other league.
  // topTwentyFive: only games with at least one ranked team are shown.
  // alerts: gets touchdown and red-zone banners.
  var LEAGUES = [
    { id: 'NFL', path: 'football/nfl', query: '', liveSeconds: 30, featured: true, alerts: true,
      stats: FOOTBALL_STATS, close: FOOTBALL_CLOSE },
    { id: 'NBA', path: 'basketball/nba', query: '', liveSeconds: 30, featured: true,
      stats: BASKETBALL_STATS, close: { period: 4, clockSeconds: 360, margin: 8 } },
    { id: 'MLB', path: 'baseball/mlb', query: '', liveSeconds: 30,
      stats: BASEBALL_STATS, close: { period: 8, margin: 2 } },
    // College slates are large, so they refresh a little less often.
    { id: 'NCAAF', path: 'football/college-football', query: '?groups=80&limit=300', liveSeconds: 60, topTwentyFive: true, alerts: true,
      stats: FOOTBALL_STATS, close: FOOTBALL_CLOSE },
    { id: 'NCAAB', path: 'basketball/mens-college-basketball', query: '?groups=50&limit=400', liveSeconds: 60, topTwentyFive: true,
      stats: BASKETBALL_STATS, close: { period: 2, clockSeconds: 300, margin: 8 } }
  ];

  var BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
  var FETCH_TIMEOUT_MS = 20000;
  var RELOAD_AFTER_MS = 6 * 60 * 60 * 1000; // a fresh start for a page left on all day
  var STALE_MS = 3 * 60 * 1000;

  var els = {
    stage: document.getElementById('stage'),
    grid: document.getElementById('grid'),
    stats: document.getElementById('stats'),
    alert: document.getElementById('alert'),
    section: document.getElementById('section'),
    pageCount: document.getElementById('pageCount'),
    status: document.getElementById('status'),
    clock: document.getElementById('clock'),
    strip: document.getElementById('strip')
  };

  var games = {};        // league id -> list of games
  var headlines = {};    // league id -> list of headlines
  var scoresDue = {};    // league id -> time of next score check
  var newsDue = {};      // league id -> time of next news check
  var requestBusy = false;
  var lastSuccess = 0;
  var everFailed = false;
  var startedAt = Date.now();

  var pages = [];
  var pageIndex = 0;
  var lastGridHtml = '';
  var lastStatsHtml = '';
  var alertQueue = [];
  var alertShowing = false;
  var redZoneAlertedAt = {};  // game and team -> when its banner last ran
  var shownScores = {};  // game id -> last score drawn, used for the score-change flash

  // ----- Small helpers -----
  function esc(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatStart(ms) {
    var when = new Date(ms);
    if (when.toDateString() === new Date().toDateString()) return formatTime(ms);
    return when.toLocaleDateString([], { weekday: 'short' }) + ' ' + formatTime(ms);
  }

  function getJSON(url) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, controller ? { signal: controller.signal } : {}).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  // ----- Turning the feed into simple game records -----
  function smallLogo(url) {
    // Asks for a TV-sized logo rather than the full 500px image.
    var match = /^https:\/\/a\.espncdn\.com(\/i\/.+\.png)$/.exec(url || '');
    return match ? 'https://a.espncdn.com/combiner/i?img=' + match[1] + '&h=120&w=120' : (url || '');
  }

  function readTeam(side) {
    var team = side.team || {};
    var rank = side.curatedRank ? side.curatedRank.current : 0;
    var record = side.records && side.records[0] ? side.records[0].summary : '';
    return {
      id: team.id,
      abbr: team.abbreviation || '',
      name: team.shortDisplayName || team.displayName || team.abbreviation || '',
      logo: smallLogo(team.logo),
      rank: rank >= 1 && rank <= 25 ? rank : 0,
      record: record,
      score: side.score
    };
  }

  function readBroadcast(competition) {
    var names = [];
    (competition.broadcasts || []).forEach(function (b) { names = names.concat(b.names || []); });
    return names.slice(0, 2).join(', ');
  }

  function readNote(competition, state) {
    var s = competition.situation;
    if (state !== 'in' || !s) return '';
    if (s.downDistanceText) return s.downDistanceText;
    if (typeof s.outs === 'number') return s.outs + (s.outs === 1 ? ' out' : ' outs');
    return '';
  }

  function readGame(league, event) {
    var competition = event.competitions && event.competitions[0];
    if (!competition || !event.status || !event.status.type) return null;
    var sides = competition.competitors || [];
    var home = sides.filter(function (c) { return c.homeAway === 'home'; })[0];
    var away = sides.filter(function (c) { return c.homeAway === 'away'; })[0];
    if (!home || !away) return null;
    var state = event.status.type.state;
    var situation = competition.situation || {};
    var homeTeam = readTeam(home);
    var awayTeam = readTeam(away);
    var game = {
      id: league.id + '-' + event.id,
      league: league.id,
      start: new Date(event.date).getTime(),
      state: state,
      detail: event.status.type.shortDetail || '',
      period: event.status.period || 0,
      clock: event.status.clock || 0,
      home: homeTeam,
      away: awayTeam,
      tv: readBroadcast(competition),
      note: readNote(competition, state),
      possession: state === 'in' ? situation.possession : null,
      redZone: state === 'in' && situation.isRedZone === true,
      scorer: readScorer(situation),
      stats: readStats(league, competition, homeTeam, awayTeam)
    };
    game.close = isCloseGame(league, game);
    return game;
  }

  function readStats(league, competition, home, away) {
    var groups = competition.leaders || [];
    (competition.competitors || []).forEach(function (side) {
      groups = groups.concat(side.leaders || []);
    });
    function teamAbbr(entry) {
      var id = entry.team ? String(entry.team.id) : '';
      if (id === String(home.id)) return home.abbr;
      return id === String(away.id) ? away.abbr : '';
    }
    var rows = [];
    league.stats.forEach(function (spec) {
      var entries = [];
      groups.forEach(function (group) {
        if (group.name === spec.name) entries = entries.concat(group.leaders || []);
      });
      entries.sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
      entries.slice(0, spec.count || 1).forEach(function (entry) {
        if (!entry.athlete) return;
        rows.push({
          label: spec.label,
          player: entry.athlete.shortName || entry.athlete.displayName,
          team: teamAbbr(entry),
          value: entry.displayValue
        });
      });
    });
    return rows;
  }

  // The player on the most recent scoring play, if the feed names one.
  function readScorer(situation) {
    var play = situation.lastPlay;
    var athlete = play && play.athletesInvolved && play.athletesInvolved[0];
    if (!play || !(play.scoreValue > 0) || !play.team || !athlete) return null;
    return { teamId: String(play.team.id), name: athlete.shortName || athlete.displayName };
  }

  function scoreMargin(game) {
    return Math.abs(Number(game.home.score) - Number(game.away.score));
  }

  function isCloseGame(league, game) {
    var rule = league.close;
    if (game.state !== 'in' || scoreMargin(game) > rule.margin) return false;
    if (game.period > rule.period) return true;   // overtime or extra innings
    var limit = rule.clockSeconds === undefined ? Infinity : rule.clockSeconds;
    return game.period === rule.period && game.clock <= limit;
  }

  function bestRank(game) {
    var ranks = [game.home.rank, game.away.rank].filter(Boolean);
    return ranks.length ? Math.min.apply(null, ranks) : 99;
  }

  // ----- Choosing what to show, bar style: a bit of every league -----
  function takeTurns(lists, limit) {
    var result = [];
    var copies = lists.map(function (list) { return list.slice(); });
    var added = true;
    while (added && result.length < limit) {
      added = false;
      for (var i = 0; i < copies.length && result.length < limit; i++) {
        if (copies[i].length) { result.push(copies[i].shift()); added = true; }
      }
    }
    return result;
  }

  function byRankThenStart(a, b) { return bestRank(a) - bestRank(b) || a.start - b.start; }
  function byStart(a, b) { return a.start - b.start; }

  // Featured leagues (NFL, NBA) take turns first; the rest follow behind them.
  function featuredFirst(listFor) {
    function turnsFor(wantFeatured) {
      return takeTurns(LEAGUES.filter(function (league) {
        return !!league.featured === wantFeatured;
      }).map(listFor), Infinity);
    }
    return turnsFor(true).concat(turnsFor(false));
  }

  function isShowable(league, game) {
    return !league.topTwentyFive || !!(game.home.rank || game.away.rank);
  }

  function showable(league) {
    return (games[league.id] || []).filter(function (g) { return isShowable(league, g); });
  }

  // Close games jump to the front, tightest score first.
  function closeGamesFirst(list) {
    var close = list.filter(function (g) { return g.close; })
      .sort(function (a, b) { return scoreMargin(a) - scoreMargin(b); });
    return close.concat(list.filter(function (g) { return !g.close; }));
  }

  function chooseGames() {
    var now = Date.now();
    return {
      live: closeGamesFirst(featuredFirst(function (league) {
        return showable(league).filter(function (g) { return g.state === 'in'; }).sort(byRankThenStart);
      })),
      upcoming: featuredFirst(function (league) {
        return showable(league).filter(function (g) {
          return g.state === 'pre' && g.start - now < UPCOMING_HOURS * 3600000;
        }).sort(byRankThenStart);
      }).slice(0, MAX_UPCOMING).sort(byStart)
    };
  }

  function buildPages() {
    var chosen = chooseGames();
    // When nothing is live, one page of the next games beats an empty screen.
    if (!chosen.live.length) {
      if (!chosen.upcoming.length) return [];
      return [{
        label: 'NEXT UP',
        className: '',
        number: 1,
        total: 1,
        games: chosen.upcoming.slice(0, CARDS_PER_PAGE)
      }];
    }
    var built = [];
    var count = Math.ceil(chosen.live.length / CARDS_PER_PAGE);
    for (var i = 0; i < count; i++) {
      built.push({
        label: 'LIVE NOW',
        className: 'live',
        number: i + 1,
        total: count,
        games: chosen.live.slice(i * CARDS_PER_PAGE, (i + 1) * CARDS_PER_PAGE)
      });
    }
    return built;
  }

  // ----- Drawing the game cards -----
  function teamRow(game, team) {
    var showScore = game.state !== 'pre';
    var hasBall = game.possession && String(game.possession) === String(team.id);
    var key = game.id + '-' + team.abbr;
    var flash = showScore && shownScores[key] !== undefined && shownScores[key] !== team.score;
    if (showScore) shownScores[key] = team.score;

    return '<div class="team">' +
      '<div class="logo-box"><img class="logo" alt="" src="' + esc(team.logo) + '" onerror="this.style.visibility=\'hidden\'"></div>' +
      '<div class="name' + (hasBall ? ' has-ball' : '') + '">' +
        (team.rank ? '<span class="rank">' + team.rank + '</span>' : '') + esc(team.name) +
      '</div>' +
      (showScore
        ? '<div class="score' + (flash ? ' flash' : '') + '">' + esc(team.score) + '</div>'
        : '<div class="record">' + esc(team.record) + '</div>') +
    '</div>';
  }

  function card(game) {
    var isLive = game.state === 'in';
    var stateText = game.state === 'pre' ? formatStart(game.start) : game.detail;
    return '<div class="card' + (isLive ? ' live' : '') + (game.close ? ' close' : '') + '">' +
      '<div class="card-top">' +
        '<span class="tag ' + game.league + '">' + game.league + '</span>' +
        (game.close ? '<span class="close-tag">CLOSE</span>' : '') +
        '<span class="state">' + (isLive ? '<span class="dot"></span>' : '') + esc(stateText) + '</span>' +
      '</div>' +
      teamRow(game, game.away) +
      teamRow(game, game.home) +
      '<div class="card-bottom">' +
        '<span class="note' + (game.redZone ? ' redzone' : '') + '">' + esc(game.note) + '</span>' +
        '<span class="tv">' + esc(game.tv) + '</span>' +
      '</div>' +
    '</div>';
  }

  function setGrid(html) {
    if (html === lastGridHtml) return;   // avoids redrawing (and flicker) when nothing changed
    lastGridHtml = html;
    els.grid.innerHTML = html;
  }

  function statBlock(game) {
    var rows = game.stats.map(function (row) {
      return '<div class="stat-row">' +
        '<span class="stat-label">' + esc(row.label) + '</span>' +
        '<span class="stat-name">' + esc(row.player) + '<em>' + esc(row.team) + '</em></span>' +
        '<span class="stat-value">' + esc(row.value) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="stat-game">' +
      '<div class="stat-head">' +
        '<span class="tag ' + game.league + '">' + game.league + '</span>' +
        esc(game.away.abbr) + ' ' + esc(game.away.score) + ' &middot; ' +
        esc(game.home.abbr) + ' ' + esc(game.home.score) +
      '</div>' +
      (rows || '<div class="stat-empty">Stats not available yet</div>') +
    '</div>';
  }

  // The panel only appears for live games; otherwise the game cards use the full width.
  function setStats(list) {
    var showPanel = list.length > 0;
    els.stage.className = 'stage' + (showPanel ? '' : ' full');
    var html = showPanel
      ? '<div class="stats-title">PLAYER STATS</div>' + list.map(statBlock).join('')
      : '';
    if (html === lastStatsHtml) return;
    lastStatsHtml = html;
    els.stats.innerHTML = html;
  }

  function drawPage() {
    pages = buildPages();
    if (!pages.length) {
      els.section.textContent = '';
      els.section.className = 'section';
      els.pageCount.textContent = '';
      setStats([]);
      var loaded = lastSuccess > 0;
      setGrid('<div class="message">' +
        (loaded ? 'No games on right now'
                : (everFailed ? 'Can&rsquo;t reach the scores. Trying again&hellip;' : 'Loading scores&hellip;')) +
        '</div>');
      return;
    }
    if (pageIndex >= pages.length) pageIndex = 0;
    var page = pages[pageIndex];
    els.section.textContent = page.label;
    els.section.className = 'section ' + page.className;
    els.pageCount.textContent = page.total > 1 ? page.number + ' of ' + page.total : '';
    setGrid(page.games.map(card).join(''));
    setStats(page.className === 'live' ? page.games : []);
  }

  function nextPage() {
    pageIndex += 1;
    drawPage();
  }

  // ----- Touchdown and red-zone banners -----
  function addAlert(kind, title, text, logo) {
    if (alertQueue.length >= MAX_ALERTS_WAITING) return;
    alertQueue.push({ kind: kind, title: title, text: text, logo: logo });
    showNextAlert();
  }

  function showNextAlert() {
    if (alertShowing || !alertQueue.length) return;
    var alert = alertQueue.shift();
    alertShowing = true;
    els.alert.innerHTML =
      '<img class="alert-logo" alt="" src="' + esc(alert.logo) + '" onerror="this.style.display=\'none\'">' +
      '<span class="alert-title">' + esc(alert.title) + '</span>' +
      '<span class="alert-text">' + esc(alert.text) + '</span>';
    els.alert.className = 'alert show ' + alert.kind;
    setTimeout(function () {
      els.alert.className = 'alert ' + alert.kind;
      setTimeout(function () {
        alertShowing = false;
        showNextAlert();
      }, 600);
    }, ALERT_SECONDS * 1000);
  }

  function scoreLine(game) {
    return game.away.abbr + ' ' + game.away.score + ', ' + game.home.abbr + ' ' + game.home.score;
  }

  // Compares new scores with the previous check. The very first check has
  // nothing to compare against, so turning the page on never sets off banners.
  function checkForAlerts(league, previousList, newList) {
    if (!league.alerts || !previousList) return;
    var before = {};
    previousList.forEach(function (g) { before[g.id] = g; });

    newList.forEach(function (game) {
      var old = before[game.id];
      if (!old || old.state !== 'in' || game.state !== 'in' || !isShowable(league, game)) return;

      [[game.away, old.away], [game.home, old.home]].forEach(function (pair) {
        var team = pair[0];
        if (Number(team.score) - Number(pair[1].score) < 6) return;
        var scorer = game.scorer && game.scorer.teamId === String(team.id) ? game.scorer.name + ' for the ' : '';
        addAlert('touchdown', 'TOUCHDOWN', scorer + team.name + ' • ' + scoreLine(game), team.logo);
      });

      if (game.redZone && !old.redZone) {
        var driving = String(game.possession) === String(game.home.id) ? game.home : game.away;
        var key = game.id + '-' + driving.id;
        if (Date.now() - (redZoneAlertedAt[key] || 0) < RED_ZONE_REPEAT_SECONDS * 1000) return;
        redZoneAlertedAt[key] = Date.now();
        addAlert('redzone', 'RED ZONE', driving.name + ' • ' + game.note, driving.logo);
      }
    });
  }

  // ----- Getting data, one request at a time so the TV is never overloaded -----
  function fetchScores(league) {
    return getJSON(BASE + league.path + '/scoreboard' + league.query).then(function (data) {
      var list = (data.events || []).map(function (event) { return readGame(league, event); }).filter(Boolean);
      checkForAlerts(league, games[league.id], list);
      games[league.id] = list;
      lastSuccess = Date.now();
      var anyLive = list.some(function (g) { return g.state === 'in'; });
      scoresDue[league.id] = Date.now() + (anyLive ? league.liveSeconds : IDLE_SECONDS) * 1000;
      drawPage();
    }).catch(function () {
      // Keeps showing the last scores it has; just tries again soon.
      everFailed = true;
      scoresDue[league.id] = Date.now() + RETRY_SECONDS * 1000;
      drawPage();
    });
  }

  function fetchNews(league) {
    return getJSON(BASE + league.path + '/news?limit=5').then(function (data) {
      headlines[league.id] = (data.articles || []).map(function (a) { return a.headline; }).filter(Boolean);
      newsDue[league.id] = Date.now() + NEWS_SECONDS * 1000;
    }).catch(function () {
      newsDue[league.id] = Date.now() + NEWS_SECONDS * 1000;   // headlines are optional
    });
  }

  function pump() {
    if (requestBusy) return;
    var now = Date.now();
    var job = null, i;
    for (i = 0; i < LEAGUES.length && !job; i++) {
      if ((scoresDue[LEAGUES[i].id] || 0) <= now) job = fetchScores(LEAGUES[i]);
    }
    for (i = 0; i < LEAGUES.length && !job; i++) {
      if ((newsDue[LEAGUES[i].id] || 0) <= now) job = fetchNews(LEAGUES[i]);
    }
    if (!job) return;
    requestBusy = true;
    job.then(function () { requestBusy = false; });
  }

  // ----- The scrolling strip -----
  // Only keeps enough items to fill the screen, which is easy on the TV's small processor.
  var stripItems = [];
  var stripPosition = 0;
  var stripOffset = 0;
  var stripWidth = 0;
  var lastFrame = 0;

  function scoreItem(game) {
    var head = '<span class="lg ' + game.league + '">' + game.league + '</span>';
    if (game.state === 'pre') {
      return head + esc(game.away.abbr) + ' @ ' + esc(game.home.abbr) +
        '<span class="when">' + esc(formatStart(game.start)) + (game.tv ? ' &middot; ' + esc(game.tv) : '') + '</span>';
    }
    return head +
      esc(game.away.abbr) + '<span class="pts">' + esc(game.away.score) + '</span>' +
      esc(game.home.abbr) + '<span class="pts">' + esc(game.home.score) + '</span>' +
      '<span class="when' + (game.state === 'in' ? ' on' : '') + '">' + esc(game.detail) + '</span>';
  }

  function buildStripItems() {
    var chosen = chooseGames();
    var scores = chosen.live.concat(chosen.upcoming).map(scoreItem);
    var news = takeTurns(LEAGUES.map(function (league) {
      return (headlines[league.id] || []).map(function (text) {
        return '<span class="lg ' + league.id + '">' + league.id + '</span>' + esc(text);
      });
    }), Infinity);

    var mixed = [], newsIndex = 0;
    scores.forEach(function (item, i) {
      mixed.push(item);
      if ((i + 1) % HEADLINE_EVERY === 0 && newsIndex < news.length) mixed.push(news[newsIndex++]);
    });
    // On a quiet day there may be too few scores to reach the first headline.
    return newsIndex ? mixed : mixed.concat(news.slice(0, HEADLINE_EVERY));
  }

  function nextStripItem() {
    if (stripPosition >= stripItems.length) {
      stripItems = buildStripItems();   // picks up the newest scores on every lap
      stripPosition = 0;
      if (!stripItems.length) return null;
    }
    return stripItems[stripPosition++];
  }

  function fillStrip() {
    var target = window.innerWidth * 1.1;
    while (stripWidth + stripOffset < target) {
      var html = nextStripItem();
      if (html === null) return;
      var el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = html;
      els.strip.appendChild(el);
      el.measuredWidth = Math.max(1, el.offsetWidth);
      stripWidth += el.measuredWidth;
    }
  }

  function animateStrip(time) {
    var elapsed = Math.min(time - (lastFrame || time), 100);
    lastFrame = time;
    stripOffset -= window.innerWidth * STRIP_SPEED * elapsed / 1000;

    var first = els.strip.firstChild;
    while (first && stripOffset + first.measuredWidth < 0) {
      stripOffset += first.measuredWidth;
      stripWidth -= first.measuredWidth;
      els.strip.removeChild(first);
      first = els.strip.firstChild;
    }
    fillStrip();
    els.strip.style.transform = 'translate3d(' + Math.round(stripOffset) + 'px,0,0)';
    window.requestAnimationFrame(animateStrip);
  }

  // ----- Clock, late-score warning, and the periodic fresh start -----
  function tickClock() {
    var text = formatTime(Date.now());
    if (els.clock.textContent !== text) els.clock.textContent = text;
    var message = lastSuccess && Date.now() - lastSuccess > STALE_MS
      ? 'Scores delayed, last update ' + formatTime(lastSuccess) : '';
    if (els.status.textContent !== message) els.status.textContent = message;
  }

  function maybeReload() {
    // Only reloads while online, so it can't get stuck on a browser error page.
    var healthy = navigator.onLine && Date.now() - lastSuccess < STALE_MS;
    if (healthy && Date.now() - startedAt > RELOAD_AFTER_MS) window.location.reload();
  }

  tickClock();
  drawPage();
  pump();
  setInterval(pump, 1000);
  setInterval(tickClock, 1000);
  setInterval(nextPage, PAGE_SECONDS * 1000);
  setInterval(maybeReload, 60000);
  window.requestAnimationFrame(animateStrip);
})();
