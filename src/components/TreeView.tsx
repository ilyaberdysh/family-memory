import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Handle, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowRight, Eraser, Undo2 } from 'lucide-react';
import type { TreeApi } from '../tree-state';
import { layoutTree, lifespan, type PersonNodeData } from '../tree-layout';
import { PersonSheet } from './PersonSheet';

type Props = { api: TreeApi; onStart: () => void };

export function TreeView({ api, onStart }: Props) {
  const { tree } = api;
  return (
    <section className="canvas">
      {tree.people.length === 0 ? <EmptyTree onStart={onStart} /> : (
        <ReactFlowProvider>
          <TreeCanvas api={api} />
        </ReactFlowProvider>
      )}
      <div className="legend" aria-label="Обозначения">
        <span><i />Со слов</span>
        <span><i className="doc" />Документ</span>
        <span><i className="hyp" />Гипотеза</span>
      </div>
    </section>
  );
}

const nodeTypes = { person: PersonNode, union: UnionNode };

function TreeCanvas({ api }: { api: TreeApi }) {
  const { tree } = api;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { nodes, edges } = useMemo(() => layoutTree(tree, selectedId), [tree, selectedId]);
  const flow = useReactFlow();
  const selected = tree.people.find(p => p.id === selectedId) ?? null;

  const initialized = useNodesInitialized();
  const host = useRef<HTMLDivElement>(null);

  // Refit when the tree grows or shrinks, once nodes are measured.
  useEffect(() => {
    if (!initialized) return;
    const frame = requestAnimationFrame(() => flow.fitView({ padding: 0.15, maxZoom: 1.1, duration: 400 }));
    return () => cancelAnimationFrame(frame);
  }, [initialized, tree.people.length, tree.relations.length, flow]);

  // Refit when the canvas itself changes size (rotation, window resize).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(() => flow.fitView({ padding: 0.15, maxZoom: 1.1 }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [flow]);

  return (
    <>
      <div className="flow-host" ref={host}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => node.type === 'person' && setSelectedId(node.id)}
        onPaneClick={() => setSelectedId(null)}
        nodeClickDistance={6}
        paneClickDistance={6}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={1.8}
        colorMode="system"
      >
        <Background gap={22} size={1} color="var(--hairline-strong)" />
      </ReactFlow>
      </div>

      <div className="tree-toolbar">
        <button className="ghost-button" onClick={api.undo} disabled={!tree.canUndo} title={tree.lastChange ? `Отменить: ${tree.lastChange}` : 'Нечего отменять'}>
          <Undo2 aria-hidden />Отменить
        </button>
        <button className="ghost-button" onClick={() => { if (confirm('Очистить древо целиком? Это можно отменить.')) api.reset(); }}>
          <Eraser aria-hidden />Очистить
        </button>
      </div>

      {selected && (
        <PersonSheet
          person={selected}
          tree={tree}
          onSelect={setSelectedId}
          onClose={() => setSelectedId(null)}
          onDelete={() => { api.remove(selected.id); setSelectedId(null); }}
        />
      )}
      {api.error && <div className="tree-error" role="alert">{api.error}</div>}
    </>
  );
}

function PersonNode({ data }: NodeProps) {
  const { person, selected } = data as PersonNodeData;
  const life = lifespan(person);
  const place = person.birth?.place;
  return (
    <div className="person-card" data-provenance={person.provenance} data-selected={selected}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <strong>{person.name}</strong>
      <small>{[life, place].filter(Boolean).join(' · ') || (person.provenance === 'hypothesis' ? 'предположение' : 'годы неизвестны')}</small>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function UnionNode() {
  return (
    <div className="union-dot">
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function EmptyTree({ onStart }: { onStart: () => void }) {
  return (
    <div className="empty">
      <GhostTree />
      <h2>Древо соберётся само</h2>
      <p>Расскажите агенту о семье, и здесь появятся люди и связи. Найденное в документах будет отмечено сплошной линией, предположения — пунктиром.</p>
      <button className="primary-button" onClick={onStart}>
        Начать с агентом <ArrowRight aria-hidden />
      </button>
    </div>
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
