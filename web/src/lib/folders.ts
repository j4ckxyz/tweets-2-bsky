import { DEFAULT_GROUP_EMOJI } from './constants';

// The default folder "emoji" is a stand-in for an icon; draw the icon instead.
// A folder emoji the user picked is content and stays as typed.
export function isDefaultFolderEmoji(emoji?: string): boolean {
  return !emoji || emoji === DEFAULT_GROUP_EMOJI;
}

export function folderText(emoji: string | undefined, name: string): string {
  return isDefaultFolderEmoji(emoji) ? name : `${emoji} ${name}`;
}
