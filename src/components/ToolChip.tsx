import { Check, CircleAlert, GitBranch, PencilLine, Trash2, UserPlus } from 'lucide-react';
import { PROVENANCE_LABEL, type Provenance } from '../../shared/types';

export type ToolPart = {
  type: string;
  toolCallId: string;
  state: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorText?: string;
};

export function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith('tool-');
}

export function ToolChip({ part, onOpen }: { part: ToolPart; onOpen: () => void }) {
  const name = part.type.slice(5);
  const input = part.input ?? {};
  const output = part.output ?? {};

  if (part.state === 'output-error') {
    return <span className="tool-chip error"><CircleAlert aria-hidden />Не получилось записать: {part.errorText}</span>;
  }
  if (part.state !== 'output-available') {
    return <span className="tool-chip pending"><span className="spinner" aria-hidden />Записываю в древо…</span>;
  }

  let icon = <Check aria-hidden />;
  let text = 'Древо обновлено';
  let provenance: Provenance | undefined;
  if (name === 'add_person') {
    icon = <UserPlus aria-hidden />;
    text = String(output.name ?? input.name);
    provenance = output.provenance as Provenance;
  } else if (name === 'update_person') {
    icon = <PencilLine aria-hidden />;
    text = `Уточнено: ${output.name}`;
  } else if (name === 'link_people') {
    icon = <GitBranch aria-hidden />;
    text = output.type === 'spouse' ? `${output.from} и ${output.to} — супруги` : `${output.from} — родитель: ${output.to}`;
  } else if (name === 'remove_person') {
    icon = <Trash2 aria-hidden />;
    text = `Убран: ${output.removed}`;
  }

  return (
    <button type="button" className="tool-chip" data-provenance={provenance} onClick={onOpen} title="Открыть древо">
      {icon}
      <span>{text}</span>
      {provenance && <em>{PROVENANCE_LABEL[provenance]}</em>}
    </button>
  );
}
