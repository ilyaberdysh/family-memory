import { ArrowRight } from 'lucide-react';

export function TreeView({ onStart }: { onStart: () => void }) {
  return (
    <section className="canvas">
      <div className="empty">
        <GhostTree />
        <h2>Древо соберётся само</h2>
        <p>Расскажите агенту о семье, и здесь появятся люди и связи. Найденное в документах будет отмечено сплошной линией, предположения — пунктиром.</p>
        <button className="primary-button" onClick={onStart}>
          Начать с агентом <ArrowRight aria-hidden />
        </button>
      </div>
      <div className="legend" aria-label="Обозначения">
        <span><i />Со слов</span>
        <span><i className="doc" />Документ</span>
        <span><i className="hyp" />Гипотеза</span>
      </div>
    </section>
  );
}

/** Three generations sketched as placeholders; no names, nothing invented. */
function GhostTree() {
  const card = (x: number, y: number, kind: 'solid' | 'dashed') => (
    <g key={`${x}-${y}`}>
      <rect className={`node ${kind}`} x={x - 44} y={y - 18} width="88" height="36" rx="10" />
      <rect className="bar" x={x - 30} y={y - 5} width="44" height="5" rx="2.5" />
      <rect className="bar" x={x - 30} y={y + 4} width="26" height="4" rx="2" />
    </g>
  );
  return (
    <svg className="ghost-tree" viewBox="0 -10 420 206" aria-hidden>
      <path className="link" d="M210 150 V122 H110 V98" />
      <path className="link" d="M210 122 H310 V98" />
      <path className="link dashed" d="M110 62 V44 H60 V30" />
      <path className="link dashed" d="M110 44 H160 V30" />
      <path className="link dashed" d="M310 62 V44 H360 V30" />
      {card(210, 168, 'solid')}
      {card(110, 80, 'solid')}
      {card(310, 80, 'solid')}
      {card(60, 14, 'dashed')}
      {card(160, 14, 'dashed')}
      {card(360, 14, 'dashed')}
    </svg>
  );
}
