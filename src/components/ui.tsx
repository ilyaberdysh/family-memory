import { useEffect, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
export function initials(name:string) { return name.trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('').toLocaleUpperCase('ru'); }
export function formatDate(value:string) { if(!value)return '';if(!/^\d{4}-\d{2}-\d{2}(T|$)/.test(value))return value;const d=new Date(value);return Number.isNaN(d.getTime())?value:new Intl.DateTimeFormat('ru',{day:'numeric',month:'short',year:'numeric'}).format(d); }
export function Avatar({name,fileId,size=44}:{name:string;fileId?:string|null;size?:number}) { let h=0;for(const c of name)h=(h+c.charCodeAt(0))%6; return <span className={`avatar avatar-${h}`} style={{width:size,height:size,fontSize:Math.round(size*.34)}}>{fileId?<img src={`/api/files/${fileId}`} alt=""/>:initials(name)||'?'}</span>; }
export function Modal({open,onClose,title,children,wide=false}:{open:boolean;onClose:()=>void;title:string;children:ReactNode;wide?:boolean}) { return <Dialog.Root open={open} onOpenChange={value=>{if(!value)onClose();}}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className={`modal ${wide?'modal-wide':''}`} aria-describedby={undefined}><div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={20}/></button></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>; }

export function useUnsavedChanges(dirty:boolean) { useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]); }
