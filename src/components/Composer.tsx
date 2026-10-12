import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, Paperclip, Square } from 'lucide-react';

export type ComposerHandle = { fill: (text: string) => void };

type Props = {
  onSend: (text: string) => void;
  onStop?: () => void;
  busy: boolean;
  placeholder: string;
  autoFocus?: boolean;
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ onSend, onStop, busy, placeholder, autoFocus }, ref) {
  const [value, setValue] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const caretToEnd = useRef(false);

  useImperativeHandle(ref, () => ({
    fill(text) {
      caretToEnd.current = true;
      setValue(text);
    },
  }));

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    if (caretToEnd.current) {
      caretToEnd.current = false;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue('');
  };

  return (
    <form className="composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea
        ref={area}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label="Сообщение агенту"
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-tools">
          <button type="button" className="icon-button" disabled title="Документы и фото — скоро"><Paperclip aria-hidden /></button>
          <button type="button" className="icon-button" disabled title="Голосом — скоро"><Mic aria-hidden /></button>
        </div>
        {busy && onStop
          ? <button type="button" className="send" onClick={onStop} aria-label="Остановить"><Square aria-hidden style={{ width: 13, height: 13 }} fill="currentColor" /></button>
          : <button type="submit" className="send" disabled={!value.trim() || busy} aria-label="Отправить"><ArrowUp aria-hidden /></button>}
      </div>
    </form>
  );
});
