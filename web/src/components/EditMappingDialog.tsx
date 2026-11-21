import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { selectClassName } from '../lib/constants';
import { useDashboard } from '../lib/dashboard-context';
import { normalizeTwitterUsername } from '../lib/format';
import { MirrorSettingsFields } from './MirrorSettingsFields';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

// Edit-account dialog.
export function EditMappingDialog() {
  const {
    addEditTwitterUsername,
    editForm,
    editTwitterInput,
    editTwitterUsers,
    editingMapping,
    handleUpdateMapping,
    isBusy,
    removeEditTwitterUsername,
    setEditForm,
    setEditTwitterInput,
    setEditingMapping,
  } = useDashboard();
  // Escape closes the dialog, like the add-account sheet.
  const isOpen = Boolean(editingMapping);
  const pressStartedOnBackdropRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, isOpen);
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditingMapping(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, setEditingMapping]);

  return editingMapping ? (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Escape is handled above
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-foreground/30 p-4 animate-backdrop-fade"
      onMouseDown={(event) => {
        pressStartedOnBackdropRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a press that both starts and ends on the backdrop dismisses, so
        // dragging a text selection out of a field does not discard the edit.
        if (event.target === event.currentTarget && pressStartedOnBackdropRef.current) {
          setEditingMapping(null);
        }
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: styled card; a native <dialog> would change layout and animation */}
      <Card
        role="dialog"
        ref={dialogRef}
        aria-modal="true"
        aria-labelledby="edit-account-title"
        className="my-auto w-full max-w-xl border-border/90 bg-card animate-fade-in"
      >
        <CardHeader>
          <CardTitle id="edit-account-title">Edit account</CardTitle>
          <CardDescription>Update ownership, handles, and target credentials.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={handleUpdateMapping}>
            <div className="space-y-2">
              <Label htmlFor="edit-owner">Owner</Label>
              <Input
                id="edit-owner"
                value={editForm.owner}
                onChange={(event) => {
                  setEditForm((prev) => ({ ...prev, owner: event.target.value }));
                }}
                required
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="space-y-2">
                <Label htmlFor="edit-groupName">Folder / Group Name</Label>
                <Input
                  id="edit-groupName"
                  value={editForm.groupName}
                  onChange={(event) => {
                    setEditForm((prev) => ({ ...prev, groupName: event.target.value }));
                  }}
                  placeholder="Gaming, News, Sports..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-groupEmoji">Emoji</Label>
                <Input
                  id="edit-groupEmoji"
                  value={editForm.groupEmoji}
                  onChange={(event) => {
                    setEditForm((prev) => ({ ...prev, groupEmoji: event.target.value }));
                  }}
                  placeholder="📁"
                  maxLength={8}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-twitterUsernames">Twitter Usernames</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-twitterUsernames"
                  value={editTwitterInput}
                  onChange={(event) => {
                    setEditTwitterInput(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                      event.preventDefault();
                      addEditTwitterUsername();
                    }
                  }}
                  placeholder="@accountname"
                />
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={normalizeTwitterUsername(editTwitterInput).length === 0}
                  onClick={addEditTwitterUsername}
                >
                  Add
                </Button>
              </div>
              <div className="flex min-h-7 flex-wrap gap-2">
                {editTwitterUsers.map((username) => (
                  <Badge key={`edit-${username}`} variant="secondary" className="gap-1 pr-1">
                    @{username}
                    <button
                      type="button"
                      className="rounded-full px-1 text-muted-foreground transition hover:bg-background hover:text-foreground"
                      onClick={() => removeEditTwitterUsername(username)}
                      aria-label={`Remove @${username}`}
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-bskyIdentifier">Bluesky Identifier</Label>
              <Input
                id="edit-bskyIdentifier"
                value={editForm.bskyIdentifier}
                onChange={(event) => {
                  setEditForm((prev) => ({ ...prev, bskyIdentifier: event.target.value }));
                }}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-profile-sync-source">Profile Sync Source</Label>
              <select
                id="edit-profile-sync-source"
                className={selectClassName}
                value={editForm.profileSyncSourceUsername}
                onChange={(event) => {
                  setEditForm((previous) => ({ ...previous, profileSyncSourceUsername: event.target.value }));
                }}
              >
                {editTwitterUsers.length > 1 ? <option value="">Select source username</option> : null}
                {editTwitterUsers.map((username) => (
                  <option key={`edit-sync-source-${username}`} value={username}>
                    @{username}
                  </option>
                ))}
              </select>
              {editTwitterUsers.length > 1 ? (
                <p className="text-xs text-muted-foreground">
                  Required when multiple Twitter usernames map to one Bluesky account.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-bskyPassword">New App Password (optional)</Label>
              <Input
                id="edit-bskyPassword"
                type="password"
                value={editForm.bskyPassword}
                onChange={(event) => {
                  setEditForm((prev) => ({ ...prev, bskyPassword: event.target.value }));
                }}
                placeholder="Leave blank to keep existing"
              />
            </div>
            <details className="rounded-lg border border-border/70 px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">Mirroring options</summary>
              <div className="pt-3">
                <MirrorSettingsFields
                  idPrefix="edit-account"
                  value={editForm}
                  onChange={(next) => setEditForm((previous) => ({ ...previous, ...next }))}
                />
              </div>
            </details>
            <div className="space-y-2">
              <Label htmlFor="edit-bskyServiceUrl">Service URL</Label>
              <Input
                id="edit-bskyServiceUrl"
                value={editForm.bskyServiceUrl}
                onChange={(event) => {
                  setEditForm((prev) => ({ ...prev, bskyServiceUrl: event.target.value }));
                }}
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  setEditingMapping(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isBusy}>
                {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save changes
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  ) : null;
}
