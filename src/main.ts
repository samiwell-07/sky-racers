import { Game } from './game/Game';
import './styles.css';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');

const game = new Game(container);
game.start();

// Handy for debugging from the browser console (dev server only).
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
