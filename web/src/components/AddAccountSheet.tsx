import { ArrowUpRight, ChevronLeft, ChevronRight, Loader2, Plus, X } from 'lucide-react';
import {
  ADD_ACCOUNT_STEPS,
  ADD_ACCOUNT_STEP_COUNT,
  DEFAULT_GROUP_EMOJI,
  DEFAULT_GROUP_NAME,
  selectClassName,
} from '../lib/constants';
import { useDashboard } from '../lib/dashboard-context';
import { getGroupKey, normalizeTwitterUsername } from '../lib/format';
import { cn } from '../lib/utils';
import { FolderGlyph } from './FolderGlyph';
import { MirrorPreview } from './MirrorPreview';
import { MirrorSettingsFields } from './MirrorSettingsFields';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

// Four-step add-account drawer.
export function AddAccountSheet() {
  const {
    addAccountStep,
    addNewTwitterUsername,
    advanceAddAccountStep,
    applyGroupPresetToNewMapping,
    authHeaders,
    closeAddAccountSheet,
    ensureTwitterMirrorProfileLoaded,
    isAddAccountSheetOpen,
    isBusy,
    isCredentialValidationBusy,
    isMirrorPreviewLoading,
    newMapping,
    newTwitterInput,
    newTwitterUsers,
    removeNewTwitterUsername,
    retreatAddAccountStep,
    reusableGroupOptions,
    selectedMirrorPreview,
    selectedMirrorSourceUsername,
    setNewMapping,
    setNewTwitterInput,
    setSelectedMirrorSourceUsername,
    submitNewMapping,
    validateAddAccountCredentials,
    validatedBskyCredentials,
  } = useDashboard();
  return isAddAccountSheetOpen ? (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; keyboard users close via the sheet's Close button
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 sm:items-stretch sm:justify-end animate-backdrop-fade"
      onClick={closeAddAccountSheet}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click handler only stops backdrop propagation, it is not an interaction */}
      {/* biome-ignore lint/a11y/useSemanticElements: styled drawer; a native <dialog> would change layout and animation */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-account-title"
        className="flex h-[95vh] w-full max-w-xl flex-col rounded-t-xl border border-border bg-card shadow-[0_16px_48px_-12px_oklch(var(--foreground)/0.3)] sm:h-full sm:rounded-none sm:rounded-l-xl animate-slide-up sm:animate-slide-in-right"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border/70 px-5 py-4">
          <div>
            <h2 id="add-account-title" className="text-lg font-semibold">
              Add account
            </h2>
            <p className="text-sm text-muted-foreground">Map X accounts to a Bluesky mirror.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={closeAddAccountSheet} aria-label="Close add account flow">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b border-border/70 px-5 py-3">
          <div className="flex items-center gap-2">
            {ADD_ACCOUNT_STEPS.map((label, index) => {
              const step = index + 1;
              const active = step === addAccountStep;
              const complete = step < addAccountStep;
              return (
                <div key={label} className="flex min-w-0 flex-1 items-center gap-2">
                  <div
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                      complete && 'border-foreground bg-foreground text-background',
                      active && 'border-foreground text-foreground',
                      !active && !complete && 'border-border text-muted-foreground',
                    )}
                  >
                    {step}
                  </div>
                  <span
                    className={cn(
                      'truncate text-xs',
                      active ? 'text-foreground' : complete ? 'text-foreground/90' : 'text-muted-foreground',
                    )}
                  >
                    {label}
                  </span>
                  {step < ADD_ACCOUNT_STEP_COUNT ? <div className="h-px flex-1 bg-border/70" /> : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {addAccountStep === 1 ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">Add Twitter source account(s)</p>
                <p className="text-xs text-muted-foreground">
                  Enter one or more usernames. We will preview metadata from your selected source.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-account-twitter-usernames">Twitter Usernames</Label>
                <div className="flex gap-2">
                  <Input
                    id="add-account-twitter-usernames"
                    value={newTwitterInput}
                    onChange={(event) => {
                      setNewTwitterInput(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ',') {
                        event.preventDefault();
                        addNewTwitterUsername();
                      }
                    }}
                    placeholder="@accountname"
                  />
                  <Button
                    variant="outline"
                    type="button"
                    disabled={normalizeTwitterUsername(newTwitterInput).length === 0}
                    onClick={addNewTwitterUsername}
                  >
                    Add
                  </Button>
                </div>
              </div>
              <div className="flex min-h-7 flex-wrap gap-2">
                {newTwitterUsers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No source usernames added yet.</p>
                ) : (
                  newTwitterUsers.map((username) => (
                    <Badge key={`new-${username}`} variant="secondary" className="gap-1 pr-1">
                      @{username}
                      <button
                        type="button"
                        className="rounded-full px-1 text-muted-foreground transition hover:bg-background hover:text-foreground"
                        onClick={() => removeNewTwitterUsername(username)}
                        aria-label={`Remove @${username}`}
                      >
                        ×
                      </button>
                    </Badge>
                  ))
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-account-source-select">Profile Mirror Source</Label>
                <select
                  id="add-account-source-select"
                  className={selectClassName}
                  value={selectedMirrorSourceUsername}
                  onChange={(event) => {
                    setSelectedMirrorSourceUsername(event.target.value);
                  }}
                >
                  {newTwitterUsers.map((username) => (
                    <option key={`source-${username}`} value={username}>
                      @{username}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">Twitter metadata preview</p>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={!selectedMirrorSourceUsername || isMirrorPreviewLoading}
                    onClick={() => {
                      if (!selectedMirrorSourceUsername) return;
                      void ensureTwitterMirrorProfileLoaded(selectedMirrorSourceUsername);
                    }}
                  >
                    {isMirrorPreviewLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Refresh preview
                  </Button>
                </div>
                {selectedMirrorPreview ? (
                  <>
                    <p>
                      <span className="font-medium">Display name:</span> {selectedMirrorPreview.mirroredDisplayName}
                    </p>
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {selectedMirrorPreview.mirroredDescription}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Add a username and fetch preview to confirm the mirrored profile text.
                  </p>
                )}
              </div>
              {selectedMirrorSourceUsername ? (
                <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
                  <MirrorPreview twitterUsername={selectedMirrorSourceUsername} authHeaders={authHeaders} />
                </div>
              ) : null}
            </div>
          ) : null}

          {addAccountStep === 2 ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">Create Bluesky account (or use existing)</p>
                <p className="text-xs text-muted-foreground">
                  Open Bluesky in a new tab, create account if needed, then generate an app password.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button asChild variant="outline">
                  <a href="https://bsky.app" target="_blank" rel="noreferrer">
                    Create account
                    <ArrowUpRight className="ml-2 h-4 w-4" />
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noreferrer">
                    I have an account
                    <ArrowUpRight className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </div>
              <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Keep this drawer open, finish account setup in Bluesky, then continue to enter credentials.
              </p>
            </div>
          ) : null}

          {addAccountStep === 3 ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">Enter Bluesky credentials</p>
                <p className="text-xs text-muted-foreground">Support includes custom PDS/service URLs.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-account-bsky-identifier">Bluesky Identifier</Label>
                <Input
                  id="add-account-bsky-identifier"
                  value={newMapping.bskyIdentifier}
                  onChange={(event) => {
                    setNewMapping((previous) => ({ ...previous, bskyIdentifier: event.target.value }));
                  }}
                  placeholder="example.bsky.social"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-account-bsky-password">Bluesky App Password</Label>
                <Input
                  id="add-account-bsky-password"
                  type="password"
                  value={newMapping.bskyPassword}
                  onChange={(event) => {
                    setNewMapping((previous) => ({ ...previous, bskyPassword: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-account-bsky-url">Bluesky Service URL</Label>
                <Input
                  id="add-account-bsky-url"
                  value={newMapping.bskyServiceUrl}
                  onChange={(event) => {
                    setNewMapping((previous) => ({ ...previous, bskyServiceUrl: event.target.value }));
                  }}
                  placeholder="https://bsky.social"
                />
              </div>
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">Credential check</p>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={isCredentialValidationBusy}
                    onClick={() => {
                      void validateAddAccountCredentials();
                    }}
                  >
                    {isCredentialValidationBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Validate
                  </Button>
                </div>
                {validatedBskyCredentials ? (
                  <p className="text-xs text-muted-foreground">
                    Authenticated as @{validatedBskyCredentials.handle} on {validatedBskyCredentials.serviceUrl}.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Validate now, or use Next to validate automatically.</p>
                )}
              </div>
            </div>
          ) : null}

          {addAccountStep === 4 ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">Verify email and create mapping</p>
                <p className="text-xs text-muted-foreground">
                  Verify email in Bluesky, then create mapping to auto-sync name, bio, avatar, and banner, and apply the
                  Bluesky bot self-label.
                </p>
              </div>
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                <p>
                  <span className="font-medium">Email status:</span>{' '}
                  {validatedBskyCredentials?.emailConfirmed ? 'confirmed' : 'not confirmed yet'}
                </p>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={validatedBskyCredentials?.settingsUrl || 'https://bsky.app/settings/account'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Bluesky account settings
                    <ArrowUpRight className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-account-owner">Owner (Optional)</Label>
                <Input
                  id="add-account-owner"
                  value={newMapping.owner}
                  onChange={(event) => {
                    setNewMapping((previous) => ({ ...previous, owner: event.target.value }));
                  }}
                  placeholder="jack"
                />
              </div>
              <div className="space-y-2">
                <Label>Use Existing Folder (Optional)</Label>
                {reusableGroupOptions.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    No folders yet. Create one below or from the Accounts tab.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {reusableGroupOptions.map((group) => {
                      const selected = getGroupKey(newMapping.groupName) === group.key;
                      return (
                        <button
                          key={`preset-group-${group.key}`}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors',
                            selected
                              ? 'border-foreground bg-foreground text-background'
                              : 'border-border bg-background text-foreground hover:bg-muted',
                          )}
                          onClick={() => applyGroupPresetToNewMapping(group.key)}
                          type="button"
                        >
                          <FolderGlyph emoji={group.emoji} />
                          <span>{group.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-2">
                  <Label htmlFor="add-account-group-name">Folder / Group Name (Optional)</Label>
                  <Input
                    id="add-account-group-name"
                    value={newMapping.groupName}
                    onChange={(event) => {
                      setNewMapping((previous) => ({ ...previous, groupName: event.target.value }));
                    }}
                    placeholder="Gaming, News, Sports..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-account-group-emoji">Emoji</Label>
                  <Input
                    id="add-account-group-emoji"
                    value={newMapping.groupEmoji}
                    onChange={(event) => {
                      setNewMapping((previous) => ({ ...previous, groupEmoji: event.target.value }));
                    }}
                    maxLength={8}
                    placeholder={DEFAULT_GROUP_EMOJI}
                  />
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Where to start</legend>
                {(
                  [
                    {
                      value: 'now',
                      title: 'Only new tweets',
                      hint: 'What is already on the X timeline is recorded as history, not posted. Use Backfill later to copy older tweets.',
                    },
                    {
                      value: 'recent',
                      title: 'Also copy the latest tweets now',
                      hint: 'The first check posts up to 50 recent tweets, dated as they were on X.',
                    },
                  ] as const
                ).map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5',
                      newMapping.startFrom === option.value ? 'border-foreground' : 'border-border/70',
                    )}
                  >
                    <input
                      type="radio"
                      name="add-account-start-from"
                      className="mt-0.5 h-4 w-4 shrink-0"
                      checked={newMapping.startFrom === option.value}
                      onChange={() => setNewMapping((previous) => ({ ...previous, startFrom: option.value }))}
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">{option.title}</span>
                      <span className="block text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <details className="rounded-lg border border-border/70 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">Mirroring options</summary>
                <div className="pt-3">
                  <MirrorSettingsFields
                    idPrefix="add-account"
                    value={newMapping}
                    onChange={(next) => setNewMapping((previous) => ({ ...previous, ...next }))}
                  />
                </div>
              </details>
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                <p>
                  <span className="font-medium">Owner:</span> {newMapping.owner || '--'}
                </p>
                <p>
                  <span className="font-medium">Twitter Sources:</span>{' '}
                  {newTwitterUsers.length > 0 ? newTwitterUsers.map((username) => `@${username}`).join(', ') : '--'}
                </p>
                <p>
                  <span className="font-medium">Bluesky Target:</span> {newMapping.bskyIdentifier || '--'}
                </p>
                <p>
                  <span className="font-medium">Mirror Source:</span>{' '}
                  {selectedMirrorSourceUsername ? `@${selectedMirrorSourceUsername}` : '--'}
                </p>
                {selectedMirrorPreview ? (
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                    {selectedMirrorPreview.mirroredDescription}
                  </p>
                ) : null}
                <p>
                  <span className="font-medium">Folder:</span>{' '}
                  {newMapping.groupName.trim()
                    ? `${newMapping.groupEmoji.trim() || DEFAULT_GROUP_EMOJI} ${newMapping.groupName.trim()}`
                    : `${DEFAULT_GROUP_EMOJI} ${DEFAULT_GROUP_NAME}`}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/70 px-5 py-4">
          <Button variant="outline" onClick={retreatAddAccountStep} disabled={addAccountStep === 1 || isBusy}>
            <ChevronLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          {addAccountStep < ADD_ACCOUNT_STEP_COUNT ? (
            <Button
              onClick={advanceAddAccountStep}
              disabled={isBusy || isMirrorPreviewLoading || isCredentialValidationBusy}
            >
              Next
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={() => void submitNewMapping()} disabled={isBusy}>
              {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Create Account
            </Button>
          )}
        </div>
      </aside>
    </div>
  ) : null;
}
