'use client';

import { useMemo } from 'react';
import { Chess, type Square } from 'chess.js';

export type BoardArrow = { from: string; to: string; color?: string };

type Props = {
  fen: string;
  rotate?: boolean;
  selectedSquare?: string | null;
  legalTargets?: string[];
  lastMove?: { from: string; to: string } | null;
  premove?: { from: string; to: string } | null;
  checkSquare?: string | null;
  coordinates?: boolean;
  arrows?: BoardArrow[];
  disabled?: boolean;
  onSquareClick: (square: string) => void;
  onMoveDrop: (from: string, to: string) => void;
  onDragSelect?: (square: string) => void;
};

// Both colours use the filled silhouettes: the CSS stroke is the outline, so a
// white piece is a solid white shape with a dark border instead of a thin,
// washed-out outline glyph (and a black piece gets a light rim so it stays
// readable on dark squares).
const pieceGlyphs: Record<string, string> = {
  wk: '♚', wq: '♛', wr: '♜', wb: '♝', wn: '♞', wp: '♟',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};
const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const ranks = ['8', '7', '6', '5', '4', '3', '2', '1'];

function center(square: string, rotate: boolean) {
  const file = files.indexOf(square[0]);
  const rank = Number(square[1]);
  const col = rotate ? 7 - file : file;
  const row = rotate ? rank - 1 : 8 - rank;
  return { x: col * 100 + 50, y: row * 100 + 50 };
}

export default function ChessBoard({
  fen,
  rotate = false,
  selectedSquare = null,
  legalTargets = [],
  lastMove = null,
  premove = null,
  checkSquare = null,
  coordinates = true,
  arrows = [],
  disabled = false,
  onSquareClick,
  onMoveDrop,
  onDragSelect,
}: Props) {
  const squares = useMemo(() => {
    let board: ReturnType<Chess['board']>;
    try { board = new Chess(fen).board(); }
    catch { board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null)); }
    return Array.from({ length: 8 }, (_, viewRow) => Array.from({ length: 8 }, (_, viewCol) => {
      const rowIndex = rotate ? 7 - viewRow : viewRow;
      const colIndex = rotate ? 7 - viewCol : viewCol;
      return { rowIndex, colIndex, viewRow, viewCol, piece: board[rowIndex][colIndex] };
    })).flat();
  }, [fen, rotate]);

  const dragStart = (event: React.DragEvent<HTMLButtonElement>, square: string, hasPiece: boolean) => {
    if (!hasPiece || disabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', square);
    onDragSelect?.(square);
  };

  return (
    <div className={`board-frame${disabled ? ' board-disabled' : ''}`}>
      <div className="chess-board" role="grid" aria-label="Chess board">
        {squares.map(({ rowIndex, colIndex, viewRow, viewCol, piece }) => {
          const square = `${files[colIndex]}${ranks[rowIndex]}`;
          const isLight = (rowIndex + colIndex) % 2 === 1;
          const isLegal = legalTargets.includes(square);
          const isSelected = selectedSquare === square;
          const isLast = lastMove?.from === square || lastMove?.to === square;
          const isPremove = premove?.from === square || premove?.to === square;
          const isCheck = checkSquare === square;
          const glyph = piece ? pieceGlyphs[`${piece.color}${piece.type}`] : null;
          const fileLabel = coordinates && viewRow === 7 ? files[colIndex] : null;
          const rankLabel = coordinates && viewCol === 0 ? ranks[rowIndex] : null;
          return (
            <button
              type="button"
              key={square}
              role="gridcell"
              aria-label={`${square}${piece ? `, ${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : ''}${isLegal ? ', legal destination' : ''}`}
              className={[
                'board-square',
                isLight ? 'square-light' : 'square-dark',
                isSelected ? 'square-selected' : '',
                isLast ? 'square-last-move' : '',
                isPremove ? 'square-premove' : '',
                isCheck ? 'square-check' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSquareClick(square)}
              onDragStart={(event) => dragStart(event, square, Boolean(piece))}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const from = event.dataTransfer.getData('text/plain');
                if (from && from !== square) onMoveDrop(from, square);
              }}
              draggable={Boolean(piece) && !disabled}
              disabled={disabled}
              data-square={square}
            >
              {rankLabel && <span className={`coord coord-rank ${isLight ? 'coord-on-light' : 'coord-on-dark'}`}>{rankLabel}</span>}
              {fileLabel && <span className={`coord coord-file ${isLight ? 'coord-on-light' : 'coord-on-dark'}`}>{fileLabel}</span>}
              {piece && <span className={`piece-glyph ${piece.color === 'w' ? 'piece-white' : 'piece-black'}`} aria-hidden="true">{glyph}</span>}
              {isLegal && <span className={piece ? 'move-capture-ring' : 'move-dot'} aria-hidden="true" />}
            </button>
          );
        })}
        {arrows.length > 0 && (
          <svg className="board-arrows" viewBox="0 0 800 800" preserveAspectRatio="none" aria-label="Checkmate explanation arrows">
            <defs>
              <marker id="mate-arrow-tip" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L8,4 L0,8 z" fill="#dd5548" />
              </marker>
            </defs>
            {arrows.map((arrow, index) => {
              const from = center(arrow.from, rotate);
              const to = center(arrow.to, rotate);
              return <line key={`${arrow.from}-${arrow.to}-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={arrow.color || '#dd5548'} strokeWidth="8" strokeLinecap="round" markerEnd="url(#mate-arrow-tip)" opacity="0.92" />;
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
