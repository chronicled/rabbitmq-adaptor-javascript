declare module '@chronicled/platform-utils-js' {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  export class Logger {
    static debug(...msgs: any[]): void;
    static info(...msgs: any[]): void;
    static error(...msgs: any[]): void;
  }

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  export class Config {
    static get(param: string): string;
  }
}
