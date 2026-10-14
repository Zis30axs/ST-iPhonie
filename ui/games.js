// 游戏: classic little games, offline, all our own (ui/games/*). The list shows each with its best score; a game fills
// the page under a bar with the score, the best and 重新开始. Arrow keys (and WASD) play on a computer, swipes and the
// on-screen pad on a phone. Leaving the app pauses a game that runs by itself; coming back, a tap goes on.
// Best scores are kept in this browser (ui/games/kit.js store).
import {createView, esc, heading} from './common.js';
import {store} from './games/kit.js';
import g2048 from './games/g2048.js';
import snake from './games/snake.js';
import tetris from './games/tetris.js';
import gomoku from './games/gomoku.js';
import mines from './games/mines.js';
import memory from './games/memory.js';
import slide from './games/slide.js';
import breakout from './games/breakout.js';

export const GAMES = [g2048, snake, tetris, gomoku, mines, memory, slide, breakout];
const scoreText = (game, n) => game.unit === '秒' ? `${n} 秒` : game.unit === '步' ? `${n} 步` : String(n);

export function gamesApp(ctx) {
  const v = createView(ctx, 'games'), best = store(ctx.win), keys = new ctx.win.AbortController();
  let game = null, play = null, paused = false;

  function renderList() {
    v.draw(heading('游戏', '', 'Arcade')
      + `<div class="game-list">${GAMES.map(g => {
        const b = best.best(g.id);
        return `<button type="button" class="game-card" data-game="${g.id}" style="--g1:${g.colors[0]};--g2:${g.colors[1]}"><span class="game-icon" aria-hidden="true">${g.icon}</span><strong>${esc(g.name)}</strong><small>${b ? `${g.lower ? '最好' : '最高'} ${esc(scoreText(g, b))}` : esc(g.note)}</small></button>`;
      }).join('')}</div>`
      + '<p class="hint game-foot">离线就能玩，最高分记在这个浏览器里。</p>');
  }
  function bar() {
    const b = best.best(game.id);
    return `<div class="game-bar"><div class="game-score"><small>${game.unit === '秒' ? '用时' : game.unit === '步' ? '步数' : '分数'}</small><b data-game-score>0</b></div><div class="game-score"><small>${game.lower ? '最好' : '最高'}</small><b data-game-best>${b ? esc(scoreText(game, b)) : '—'}</b></div><button type="button" class="chip-button" data-action="game-restart">重新开始</button></div>`;
  }
  function open(id) {
    close();
    game = GAMES.find(g => g.id === id);
    if (!game) return renderList();
    v.draw(`<div class="game-page" data-playing="${game.id}"><h2 class="game-title">${esc(game.name)}</h2>${bar()}<div class="game-host" data-game-host></div><p class="hint game-how">${esc(game.how)}</p><div class="game-over" data-game-over hidden></div></div>`);
    const host = v.root.querySelector('[data-game-host]');
    paused = false;
    best.played(game.id);
    play = game.make({doc: ctx.doc, win: ctx.win, host, api: {
      score: n => { const el = v.root.querySelector('[data-game-score]'); if (el) el.textContent = scoreText(game, n); },
      /** The game ended: the score is offered as a best; the card says so. win: it was won (not lost). */
      over: ({score = 0, win = false, text = '', goOn = false} = {}) => {
        const record = best.offer(game.id, score, {lower: !!game.lower});
        const el = v.root.querySelector('[data-game-over]');
        if (!el) return;
        el.innerHTML = `<div class="game-over-card"><strong>${record ? '新纪录！' : win ? '赢啦！' : '游戏结束'}</strong>${text ? `<p>${esc(text)}</p>` : ''}${score ? `<p class="game-over-score">${esc(scoreText(game, score))}</p>` : ''}<div class="actions">${goOn ? '<button type="button" class="secondary" data-action="game-go-on">接着玩</button>' : ''}<button type="button" class="primary" data-action="game-restart">再来一局</button></div></div>`;
        el.hidden = false;
        if (record) { const b = v.root.querySelector('[data-game-best]'); if (b) b.textContent = scoreText(game, score); }
      },
    }});
  }
  function close() { play?.dispose?.(); play = null; game = null; paused = false; }
  function restart() {
    if (!game) return;
    v.root.querySelector('[data-game-over]').hidden = true;
    paused = false;
    best.played(game.id);
    play?.restart();
  }
  function showPause() {
    const el = v.root.querySelector('[data-game-over]');
    if (!el || !el.hidden) return;
    el.innerHTML = '<div class="game-over-card"><strong>已暂停</strong><button type="button" class="primary" data-action="game-go-on">继续</button></div>';
    el.hidden = false;
  }

  v.on('click', '[data-game]', el => open(el.dataset.game));
  v.on('click', '[data-action=game-restart]', () => restart());
  v.on('click', '[data-action=game-go-on]', () => { v.root.querySelector('[data-game-over]').hidden = true; paused = false; play?.resume?.(); });
  // Keys while the game is on screen (not while typing somewhere).
  ctx.doc.addEventListener('keydown', e => {
    if (!play || paused || v.disposed || ctx.visible?.('games') === false || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (!v.root.querySelector('[data-game-over]')?.hidden) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); v.root.querySelector('[data-game-over] button')?.click(); } return; }
    if (play.key?.(e)) e.preventDefault();
  }, {signal: keys.signal});
  ctx.doc.addEventListener('keyup', e => { if (play && !paused) play.keyup?.(e); }, {signal: keys.signal});

  v.back = () => { if (!game) return false; close(); renderList(); return true; };
  v.leave = () => { if (play?.pause && play.pause() !== false && game?.live) { paused = true; showPause(); } };
  v.refresh = () => { if (!game) renderList(); };
  const dispose = v.dispose;
  v.dispose = () => { close(); keys.abort(); dispose(); };
  renderList();
  return v;
}
