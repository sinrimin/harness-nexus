import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, LoaderIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { FormDialog } from '@/components/ui/form-dialog';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { cn } from '@/lib/utils';

/**
 * The composer's file-reference picker (9 W9 C) — a lazy workspace tree like
 * DirPicker, but FILE rows select (inserting a `resource_link` chip) while
 * directory rows expand. One `workspace:list` round-trip per level; picking
 * a file closes the dialog.
 */

interface DirNode {
  path: string;
  name: string;
  expanded: boolean;
  children: DirNode[] | null;
  files: { name: string; path: string }[] | null;
}

interface FilePickerProps {
  open: boolean;
  onClose: () => void;
  machineId: string;
  baseWorkspace: string | null;
  onPick: (file: { name: string; path: string }) => void;
}

export function FilePicker({ open, onClose, machineId, baseWorkspace, onPick }: FilePickerProps) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [root, setRoot] = useState<DirNode | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setRoot(null);
  }, [open]);

  const loadLevel = useCallback(
    async (path: string): Promise<{ dirs: DirNode[]; files: { name: string; path: string }[] }> => {
      const res = await withAuthGuard(() => api.listMachineWorkspace(machineId, path), logout);
      return {
        dirs: res.directories.map((d) => ({
          path: d.path,
          name: d.name,
          expanded: false,
          children: null,
          files: null,
        })),
        files: res.files,
      };
    },
    [machineId, logout],
  );

  useEffect(() => {
    if (!open || baseWorkspace === null) return;
    void (async () => {
      try {
        const { dirs, files } = await loadLevel(baseWorkspace);
        setRoot({
          path: baseWorkspace,
          name: baseWorkspace,
          expanded: true,
          children: dirs,
          files,
        });
      } catch (e) {
        toast.error(e instanceof HarnessNexusError ? e.message : t('chat.workspaceLoadFailed'));
        setRoot({
          path: baseWorkspace,
          name: baseWorkspace,
          expanded: true,
          children: [],
          files: [],
        });
      }
    })();
  }, [open, baseWorkspace, loadLevel, t]);

  const expand = useCallback(
    (node: DirNode): void => {
      if (node.children !== null || loadingPath !== null) return;
      setLoadingPath(node.path);
      void (async () => {
        let level: { dirs: DirNode[]; files: { name: string; path: string }[] } = {
          dirs: [],
          files: [],
        };
        try {
          level = await loadLevel(node.path);
        } catch {
          /* empty level on failure */
        }
        const apply = (target: DirNode): DirNode => {
          if (target.path === node.path) {
            return { ...target, expanded: true, children: level.dirs, files: level.files };
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

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('chat.pickFile')}
      description={t('chat.pickFileDesc')}
      size="lg"
      footer={
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      }
    >
      {baseWorkspace === null ? (
        <p className="text-muted-foreground text-sm">{t('chat.needsBaseWorkspace')}</p>
      ) : (
        <div className="bg-muted/50 max-h-80 overflow-y-auto rounded-md border p-2 font-mono text-xs">
          {root === null ? (
            <div className="text-muted-foreground flex items-center gap-2 px-2 py-2">
              <LoaderIcon className="size-3.5 animate-spin" />
              {t('common.loading')}
            </div>
          ) : (
            <LevelRows
              node={root}
              depth={0}
              loadingPath={loadingPath}
              onExpand={expand}
              onPick={(file) => {
                onPick(file);
                onClose();
              }}
            />
          )}
        </div>
      )}
    </FormDialog>
  );
}

function LevelRows({
  node,
  depth,
  loadingPath,
  onExpand,
  onPick,
}: {
  node: DirNode;
  depth: number;
  loadingPath: string | null;
  onExpand: (node: DirNode) => void;
  onPick: (file: { name: string; path: string }) => void;
}): React.ReactNode {
  return (
    <>
      {depth > 0 ? (
        <button
          type="button"
          onClick={() => onExpand(node)}
          className={cn(
            'hover:bg-accent/60 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left',
            node.expanded && 'bg-accent/40',
          )}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          title={node.path}
          // The row prints the basename; the path it stands for (the value the
          // tooltip hid) is announced instead.
          aria-label={node.path}
          aria-expanded={node.expanded}
        >
          {node.children === null && loadingPath === node.path ? (
            <LoaderIcon className="size-3 shrink-0 animate-spin" />
          ) : node.expanded ? (
            <ChevronDownIcon className="size-3 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0" />
          )}
          <FolderIcon className="size-3 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      ) : null}
      {node.files?.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => onPick(f)}
          className="hover:bg-accent flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left"
          style={{ paddingLeft: `${depth * 14 + 22}px` }}
          title={f.path}
          aria-label={f.path}
        >
          <FileIcon className="size-3 shrink-0" />
          <span className="truncate">{f.name}</span>
        </button>
      ))}
      {node.expanded
        ? node.children?.map((child) => (
            <LevelRows
              key={child.path}
              node={child}
              depth={depth + 1}
              loadingPath={loadingPath}
              onExpand={onExpand}
              onPick={onPick}
            />
          ))
        : null}
    </>
  );
}
