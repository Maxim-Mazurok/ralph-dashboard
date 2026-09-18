declare module 'ansi-to-html' {
  type Options = {
    bg?: string
    fg?: string
    newline?: boolean
    escapeXML?: boolean
    stream?: boolean
  }

  export default class Convert {
    constructor(options?: Options)
    toHtml(input: string | string[]): string
  }
}