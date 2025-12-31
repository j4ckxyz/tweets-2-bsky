declare module '@steipete/bird/dist/lib/twitter-client' {
  export interface TwitterClientOptions {
    cookies: {
      authToken: string;
      ct0: string;
    };
  }

  export interface TwitterUser {
    username: string;
    id?: string;
    name?: string;
  }

  export interface TwitterUserResult {
    success: boolean;
    user?: TwitterUser;
    error?: Error | string;
  }

  export interface TwitterSearchResult {
    success: boolean;
    tweets?: unknown[];
    error?: Error | string;
  }

  export class TwitterClient {
    constructor(options: TwitterClientOptions);
    getCurrentUser(): Promise<TwitterUserResult>;
    search(query: string, limit: number): Promise<TwitterSearchResult>;
    mapTweetResult(result: unknown): unknown;
  }
}

declare module 'franc-min' {
  const franc: (text: string) => string;
  export default franc;
  export = franc;
}

declare module 'iso-639-1' {
  const iso6391: {
    getCode(name: string): string | undefined;
    getName(code: string): string | undefined;
    getAllNames(): string[];
    getAllCodes(): string[];
  };
  export default iso6391;
}
