import { memo, useMemo, useEffect } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, useNodesState, type Node, type NodeProps, type Edge, BackgroundVariant } from '@xyflow/react';
import { layoutFamily, relationPorts } from './tree-layout';
import { Network, Plus, Scan, X } from 'lucide-react';
import { Avatar } from './ui';
import type { AppState, Person } from '../../shared/types';
import '@xyflow/react/dist/style.css';
import './TreeCanvas.css';

type PersonNodeData = { person:Person; subtitle:string; pending:boolean; active:boolean; sourcePorts:{id:string;offset:number}[]; targetPorts:{id:string;offset:number}[]; onChoose:()=>void; [key:string]:unknown };
const PersonNode = memo(({data}:NodeProps<Node<PersonNodeData>>) => <div role="button" tabIndex={0} aria-label={`${data.person.name}${data.subtitle ? `, ${data.subtitle}` : ''}`} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();data.onChoose();}}} className={`person-node ${data.active?'is-active':''}`}>
 {data.targetPorts.map(port=><Handle key={port.id} id={port.id} type="target" position={Position.Top} style={{left:`${port.offset}%`}}/>)}{data.sourcePorts.map(port=><Handle key={port.id} id={port.id} type="source" position={Position.Bottom} style={{left:`${port.offset}%`}}/>)}<Handle id="partner-left" type="target" position={Position.Left}/><Handle id="partner-right" type="source" position={Position.Right}/>
 <Avatar name={data.person.name} fileId={data.person.avatarFileId} size={42}/><span className="person-node-text"><strong>{data.person.name}</strong><small>{data.subtitle || 'Даты не указаны'}</small></span>{data.pending&&<span className="node-pending" title="Есть неподтверждённые сведения"/>}
</div>);
const nodeTypes={person:PersonNode};
export default function TreeCanvas({state,selectedId,focusId,onSelect,onClearFocus,onAdd}:{state:AppState;selectedId:string|null;focusId:string|null;onSelect:(id:string)=>void;onClearFocus:()=>void;onAdd:()=>void}) {
 const {people,facts,relations}=state;
 const visible=useMemo(()=>{if(!focusId)return people;let ids=new Set([focusId]);for(let i=0;i<2;i++){const prev=new Set(ids);for(const r of relations){if(prev.has(r.fromId))ids.add(r.toId);if(prev.has(r.toId))ids.add(r.fromId);}}return people.filter(p=>ids.has(p.id));},[people,relations,focusId]);
 const layout=useMemo(()=>{
  const ids=new Set(visible.map(p=>p.id));const rels=relations.filter(r=>ids.has(r.fromId)&&ids.has(r.toId));
  const positions=layoutFamily(visible,rels);
  const nodes:Node<PersonNodeData>[]=visible.map(p=>{
   const birth=facts.find(f=>f.personId===p.id&&f.key==='birthDate')?.value;
   const death=facts.find(f=>f.personId===p.id&&f.key==='deathDate')?.value;
   return {id:p.id,type:'person',position:positions.get(p.id)!,data:{person:p,subtitle:[birth,death].filter(Boolean).join(' — '),pending:facts.some(f=>f.personId===p.id&&f.status!=='confirmed'),active:false,sourcePorts:relationPorts(p.id,rels,positions,'source'),targetPorts:relationPorts(p.id,rels,positions,'target'),onChoose:()=>onSelect(p.id)}};
  });
  const edges:Edge[]=rels.map(r=>{let a=r.fromId,b=r.toId;if(r.type==='partner'&&(positions.get(a)?.x||0)>(positions.get(b)?.x||0))[a,b]=[b,a];return {id:r.id,ariaLabel:`${people.find(p=>p.id===r.fromId)?.name} — ${r.type==='partner'?'партнёр':'родитель'} ${people.find(p=>p.id===r.toId)?.name}`,source:a,target:b,type:r.type==='partner'?'straight':'default',sourceHandle:r.type==='partner'?'partner-right':`source-${r.id}`,targetHandle:r.type==='partner'?'partner-left':`target-${r.id}`,style:{stroke:r.status==='disputed'?'#c77d3a':'#a8b2c0',strokeWidth:1.5,strokeDasharray:r.type==='partner'?'5 4':undefined},label:r.type==='partner'?'':r.parentKind==='adoptive'?'Усыновление':undefined,labelStyle:{fill:'#6e7581',fontSize:11}};});
  return {nodes,edges};
 },[visible,people,relations,facts,onSelect]);
 const edges=useMemo(()=>layout.edges.map(edge=>{const related=edge.source===selectedId||edge.target===selectedId;return {...edge,zIndex:related?2:0,style:{...edge.style,stroke:related?'#007aff':edge.style?.stroke,strokeWidth:related?2:1.5,opacity:selectedId && !related ? 0.45 : 1}};}),[layout.edges,selectedId]);
 const [nodes,setNodes,onNodesChange]=useNodesState(layout.nodes);
 useEffect(()=>setNodes(layout.nodes),[layout.nodes,setNodes]);
 useEffect(()=>setNodes(current=>current.map(n=>({...n,data:{...n.data,active:n.id===selectedId}}))),[layout.nodes,setNodes,selectedId]);
 if(!people.length)return <div className="tree-empty"><div className="empty-symbol"><Network size={38} strokeWidth={1.35}/></div><h2>Добавьте первого человека</h2><p>Можно начать с себя или любого родственника.<br/>Остальные ветки появятся постепенно.</p>{state.user.role!=='viewer'&&<button className="button primary" onClick={onAdd}><Plus size={18}/>Добавить человека</button>}</div>;
 return <div className="tree-canvas">{focusId&&<div className="canvas-focus"><Scan size={15}/><span>Близкие · {people.find(p=>p.id===focusId)?.name}</span><button className="icon-button small" aria-label="Показать всю семью" onClick={onClearFocus}><X size={16}/></button></div>}<ReactFlow key={focusId||'all'} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeClick={(_,n)=>onSelect(n.id)} onPaneClick={()=>{}} fitView fitViewOptions={{padding:.28,maxZoom:1}} minZoom={.2} maxZoom={1.5} nodesFocusable={false} edgesFocusable={false} ariaLabelConfig={{'controls.zoomIn.ariaLabel':'Приблизить','controls.zoomOut.ariaLabel':'Отдалить','controls.fitView.ariaLabel':'Показать всё дерево'}} nodesConnectable={false} nodesDraggable={true} elementsSelectable={false} aria-label="Семейное дерево" zoomOnDoubleClick={false}><Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#dde2e9"/><Controls showInteractive={false} aria-label="Масштаб дерева"/></ReactFlow><div className="canvas-caption">{selectedId?'Синим выделены прямые связи выбранного человека':'Родители выше детей · пунктир — партнёры'}</div></div>;
}
