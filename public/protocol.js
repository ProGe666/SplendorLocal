(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PROTOCOL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    COLORS: ['white', 'blue', 'green', 'red', 'black'],
    GEM_TOTALS: { 2: 4, 3: 5, 4: 7 },
    GOLD_TOTAL: 5,
    TOKEN_LIMIT: 10,
    RESERVE_LIMIT: 3,
    WIN_POINTS: 15,
    CITY_COUNT: 3,

    C: {
      HELLO: 'hello',
      CREATE_ROOM: 'createRoom',
      JOIN_ROOM: 'joinRoom',
      LEAVE_ROOM: 'leaveRoom',
      START_GAME: 'startGame',
      RESTART: 'restart',
      ABANDON_GAME: 'abandonGame',
      UPDATE_OPTIONS: 'updateOptions',
      ADD_BOT: 'addBot',
      REMOVE_BOT: 'removeBot',
      CLOSE_ROOM: 'closeRoom',
      ACTION: 'action',
      PING: 'ping'
    },

    S: {
      WELCOME: 'welcome',
      ROOM: 'room',
      GAME: 'game',
      ERROR: 'error',
      PONG: 'pong',
      ROOM_CLOSED: 'roomClosed'
    },

    ACT: {
      TAKE_GEMS: 'takeGems',
      BUY: 'buy',
      RESERVE: 'reserve',
      DISCARD: 'discard',
      CHOOSE_NOBLE: 'chooseNoble',
      CHOOSE_TP: 'chooseTradingPost',
      CHOOSE_PEEK: 'choosePeek',
      BONUS_GEM: 'bonusGem'
    },

    ERR: {
      NOT_YOUR_TURN: 'NOT_YOUR_TURN',
      INVALID_ACTION: 'INVALID_ACTION',
      NEED_BONUS_COLOR: 'NEED_BONUS_COLOR',
      ROOM_FULL: 'ROOM_FULL',
      ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
      GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
      NOT_HOST: 'NOT_HOST',
      NEED_MORE_PLAYERS: 'NEED_MORE_PLAYERS',
      BAD_REQUEST: 'BAD_REQUEST',
      IN_ROOM: 'IN_ROOM'
    }
  };
});
