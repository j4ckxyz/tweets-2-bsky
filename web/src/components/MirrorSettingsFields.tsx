import { selectClassName } from '../lib/constants';
import type { EditMode, MirrorSettings, SensitiveFallbackLabel } from '../types';
import { Label } from './ui/label';

interface MirrorSettingsFieldsProps {
  idPrefix: string;
  value: MirrorSettings;
  onChange: (next: MirrorSettings) => void;
}

const SENSITIVE_OPTIONS: { value: SensitiveFallbackLabel; label: string }[] = [
  { value: 'sexual', label: 'Sexually suggestive (default)' },
  { value: 'nudity', label: 'Nudity' },
  { value: 'graphic-media', label: 'Graphic media' },
  { value: 'none', label: 'No label' },
];

const EDIT_OPTIONS: { value: EditMode; label: string }[] = [
  { value: 'skip', label: 'Keep first version' },
  { value: 'replace', label: 'Replace with edit' },
];

function Toggle({
  id,
  checked,
  onChange,
  title,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 px-3 py-2.5"
    >
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

/** How a mirror behaves on Bluesky: shared by the add and edit account forms. */
export function MirrorSettingsFields({ idPrefix, value, onChange }: MirrorSettingsFieldsProps) {
  const set = <K extends keyof MirrorSettings>(key: K, next: MirrorSettings[K]) => onChange({ ...value, [key]: next });

  return (
    <div className="space-y-3">
      <Toggle
        id={`${idPrefix}-retweets`}
        checked={value.mirrorRetweets}
        onChange={(checked) => set('mirrorRetweets', checked)}
        title="Retweets become reposts"
        hint="A retweet of a tweet mirrored on this instance is reposted on Bluesky. Other retweets are never copied."
      />
      <Toggle
        id={`${idPrefix}-replies`}
        checked={value.mirrorRepliesToMirrors}
        onChange={(checked) => set('mirrorRepliesToMirrors', checked)}
        title="Reply to other mirrors"
        hint="Replies to accounts mirrored here are posted as real Bluesky replies, so conversations thread natively."
      />
      <Toggle
        id={`${idPrefix}-bot-suffix`}
        checked={value.botDisplayNameSuffix}
        onChange={(checked) => set('botDisplayNameSuffix', checked)}
        title='Add "{bot}" to the display name'
        hint="The account always carries Bluesky's own bot label; this adds the text suffix as well."
      />
      <Toggle
        id={`${idPrefix}-sync-deletes`}
        checked={value.syncDeletes}
        onChange={(checked) => set('syncDeletes', checked)}
        title="Delete posts deleted on X"
        hint="Checks recent tweets through X's public embed service (not your X login). A tweet must be gone on two checks six hours apart before its post is removed."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-edit-mode`}>When a tweet is edited</Label>
          <select
            id={`${idPrefix}-edit-mode`}
            className={selectClassName}
            value={value.editMode}
            onChange={(event) => set('editMode', event.target.value as EditMode)}
          >
            {EDIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Replacing deletes the earlier post (and its likes and replies) and posts the new text.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-sensitive`}>Tweets marked sensitive</Label>
          <select
            id={`${idPrefix}-sensitive`}
            className={selectClassName}
            value={value.sensitiveFallbackLabel}
            onChange={(event) => set('sensitiveFallbackLabel', event.target.value as SensitiveFallbackLabel)}
          >
            {SENSITIVE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Used when X flags a tweet without saying why. Media X does categorise is always labelled to match.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Just the settings keys, for sending to the API. */
export function pickMirrorSettings(value: MirrorSettings): MirrorSettings {
  return {
    sensitiveFallbackLabel: value.sensitiveFallbackLabel,
    editMode: value.editMode,
    mirrorRetweets: value.mirrorRetweets,
    mirrorRepliesToMirrors: value.mirrorRepliesToMirrors,
    botDisplayNameSuffix: value.botDisplayNameSuffix,
    syncDeletes: value.syncDeletes,
  };
}
