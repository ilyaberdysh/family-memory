import { useEffect, useState } from 'react';
import { Images, MessageCircle, Network, SquarePen } from 'lucide-react';
import { AgentView, clearConversation } from './components/AgentView';
import { AlbumView } from './components/AlbumView';
import { Logo } from './components/Logo';
import { TreeView } from './components/TreeView';
import { useModelStatus } from './model-status';
import { useTree } from './tree-state';

export type Tab = 'agent' | 'tree' | 'album';

const TABS: { id: Tab; label: string; icon: typeof Network }[] = [
  { id: 'agent', label: 'Агент', icon: MessageCircle },
  { id: 'tree', label: 'Древо', icon: Network },
  { id: 'album', label: 'Альбом', icon: Images },
];

function tabFromHash(): Tab {
  const hash = window.location.hash.slice(1);
  return TABS.some(tab => tab.id === hash) ? (hash as Tab) : 'agent';
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [scrolled, setScrolled] = useState(false);
  const [conversationKey, setConversationKey] = useState(0);
  const [hasConversation, setHasConversation] = useState(false);
  const model = useModelStatus();
  const treeApi = useTree();
  const { refresh: refreshTree } = treeApi;

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const go = (next: Tab) => {
    window.location.hash = next === 'agent' ? '' : next;
    setTab(next);
    window.scrollTo({ top: 0 });
  };

  const index = TABS.findIndex(item => item.id === tab);

  return (
    <div className="app">
      <header className="header" data-scrolled={scrolled}>
        <a className="brand" href="#" onClick={event => { event.preventDefault(); go('agent'); }}>
          <Logo />
          <span>Корни</span>
        </a>

        <nav className="segmented" role="tablist" aria-label="Разделы" style={{ '--index': index } as React.CSSProperties}>
          <span className="segmented-thumb" aria-hidden />
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} className="segment" role="tab" aria-selected={tab === id} onClick={() => go(id)}>
              <Icon aria-hidden />
              {label}
              {id === 'tree' && treeApi.tree.people.length > 0 && <span className="count">{treeApi.tree.people.length}</span>}
            </button>
          ))}
        </nav>

        <div className="header-end">
          {tab === 'agent' && hasConversation && (
            <button className="ghost-button" onClick={() => { clearConversation(); setConversationKey(key => key + 1); }} title="Новый разговор">
              <SquarePen aria-hidden />
              <span className="label">Новый разговор</span>
            </button>
          )}
          <span
            className="status-dot"
            data-ready={model === null ? undefined : model.ready}
            title={model === null ? 'Проверяем модель…' : model.ready ? `Модель: ${model.model}` : model.reason}
          />
        </div>
      </header>

      <main className="main">
        {tab === 'agent' && <AgentView key={conversationKey} tree={treeApi.tree} onTreeChanged={refreshTree} onOpenTree={() => go('tree')} onActiveChange={setHasConversation} />}
        {tab === 'tree' && <TreeView api={treeApi} onStart={() => go('agent')} />}
        {tab === 'album' && <AlbumView />}
      </main>
    </div>
  );
}
