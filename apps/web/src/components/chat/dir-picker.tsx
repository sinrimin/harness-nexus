import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, LoaderIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormDialog } from '@/components/ui/form-dialog';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { cn } from '@/lib/utils';

/**
 * The chat session directory picker (Phase 9 W6) — a lazy tree of the
 * machine's baseWorkspace subdirectories, one `workspace:list` round-trip per
 * expanded level. If the machine has no base workspace yet, the dialog offers
 * the owner an inline field to set one first (same PATCH as the machine page).
 */

interface DirNode {
  path: string;
  name: string;
  expanded: boolean;
  loading: boolean;
  children: DirNode[] | null;
}

interface DirPickerProps {
  open: boolean;
  onClose: () => void;
  machineId: string;
  baseWorkspace: string | null;
  onBaseWorkspaceSaved: (base: string) => void;
  onPick: (directory: string) => void;
}

export function DirPicker({
  open,
  onClose,
  machineId,
  baseWorkspace,
  onBaseWorkspaceSaved,
  onPick,
}: DirPickerProps) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [root, setRoot] = useState<DirNode | null>(null);
  const [selected, setSelected] = useState('');
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [draftBase, setDraftBase] = useState('');
  const [savingBase, setSavingBase] = useState(false);

  useEffect(() => {
    if (!open) {
      setRoot(null);
      setSelected('');
      setDraftBase('');
    }
  }, [open]);

  const loadLevel = useCallback(
    async (path: string): Promise<DirNode[]> => {
      const res = await withAuthGuard(() => api.listMachineWorkspace(machineId, path), logout);
      return res.directories.map((d) => ({
        path: d.path,
        name: d.name,
        expanded: false,
        loading: false,
        children: null,
      }));
    },
    [machineId, logout],
  );

  // Load the root level whenever the dialog opens with a base workspace.
  useEffect(() => {
    if (!open || baseWorkspace === null) return;
    void (async () => {
      try {
        const children = await loadLevel(baseWorkspace);
        setRoot({
          path: baseWorkspace,
          name: baseWorkspace,
          expanded: true,
          loading: false,
          children,
        });
      } catch (e) {
        toast.error(e instanceof HarnessNexusError ? e.message : t('chat.workspaceLoadFailed'));
        setRoot({
          path: baseWorkspace,
          name: baseWorkspace,
          expanded: true,
          loading: false,
          children: [],
        });
      }
    })();
  }, [open, baseWorkspace, loadLevel, t]);

  const expand = useCallback(
    (node: DirNode): void => {
      if (node.children !== null || loadingPath !== null) return;
      setLoadingPath(node.path);
      void (async () => {
        let children: DirNode[] = [];
        try {
          children = await loadLevel(node.path);
        } catch {
          children = [];
        }
        const apply = (target: DirNode): DirNode => {
          if (target.path === node.path) {
            return { ...target, loading: false, expanded: true, children };
          }
          if (target.children !== null) {
            return { ...target, children: target.children.map(apply) };
          }
          return target;
        };
        setRoot((prev) => (prev === null ? prev : apply(prev)));
        setLoadingPath(null);
      })();
    },
    [loadLevel, loadingPath],
  );

  async function saveBaseWorkspace(): Promise<void> {
    const value = draftBase.trim();
    if (value === '') return;
    setSavingBase(true);
    try {
      const machine = await withAuthGuard(
        () => api.updateMachine(machineId, { baseWorkspace: value }),
        logout,
      );
      toast.success(t('chat.workspaceSaved'));
      onBaseWorkspaceSaved(machine.baseWorkspace ?? value);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setSavingBase(false);
    }
  }

  const rootName = useMemo(
    () =>
      baseWorkspace !== null
        ? (baseWorkspace.replace(/\/+$/, '').split('/').pop() ?? baseWorkspace)
        : '',
    [baseWorkspace],
  );

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('chat.pickDirectory')}
      description={t('chat.pickDirectoryDesc')}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={selected === ''}
            onClick={() => {
              onPick(selected);
              onClose();
            }}
          >
            {t('chat.useDirectory')}
          </Button>
        </>
      }
    >
      {baseWorkspace === null ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">{t('chat.needsBaseWorkspace')}</p>
          <div className="grid gap-2">
            <Label htmlFor="chat-base-workspace">{t('chat.baseWorkspaceLabel')}</Label>
            <Input
              id="chat-base-workspace"
              value={draftBase}
              onChange={(e) => setDraftBase(e.target.value)}
              placeholder="/home/user/projects"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">{t('chat.baseWorkspaceHint')}</p>
          </div>
          <Button
            className="self-start"
            disabled={draftBase.trim() === '' || savingBase}
            onClick={() => void saveBaseWorkspace()}
          >
            {savingBase ? t('common.saving') : t('chat.setBaseWorkspace')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="bg-muted/50 max-h-80 overflow-y-auto rounded-md border p-2 font-mono text-xs">
            <button
              type="button"
              onClick={() => setSelected(baseWorkspace)}
              className={cn(
                'hover:bg-accent flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left',
                selected === baseWorkspace && 'bg-accent',
              )}
            >
              <FolderIcon className="size-3.5 shrink-0" />
              {/* No `title` here (P6): the full path is already printed on the
                  right, so the tooltip was a second copy of a visible value. */}
              <span className="truncate">{rootName === '' ? baseWorkspace : rootName}</span>
              <span className="text-muted-foreground/60 ml-auto shrink-0">{baseWorkspace}</span>
            </button>
            {root === null ? (
              <div className="text-muted-foreground flex items-center gap-2 px-2 py-2">
                <LoaderIcon className="size-3.5 animate-spin" />
                {t('common.loading')}
              </div>
            ) : (
              <NodeList
                node={root}
                depth={1}
                selected={selected}
                onSelect={setSelected}
                onExpand={expand}
                loadingPath={loadingPath}
              />
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="chat-selected-dir">{t('chat.selectedDirectory')}</Label>
            <Input
              id="chat-selected-dir"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              placeholder={baseWorkspace}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
        </div>
      )}
    </FormDialog>
  );
}

function NodeList({
  node,
  depth,
  selected,
  onSelect,
  onExpand,
  loadingPath,
}: {
  node: DirNode;
  depth: number;
  selected: string;
  onSelect: (path: string) => void;
  onExpand: (node: DirNode) => void;
  loadingPath: string | null;
}): React.ReactNode {
  if (node.children === null) {
    return (
      <button
        type="button"
        onClick={() => onExpand(node)}
        className="hover:bg-accent/60 text-muted-foreground flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {loadingPath === node.path ? (
          <LoaderIcon className="size-3 shrink-0 animate-spin" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={cn(
          'hover:bg-accent flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left',
          selected === node.path && 'bg-accent',
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        title={node.path}
      >
        <ChevronDownIcon className="size-3 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {node.children.map((child) => (
        <NodeList
          key={child.path}
          node={child}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          onExpand={onExpand}
          loadingPath={loadingPath}
        />
      ))}
    </>
  );
}
