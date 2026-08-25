/**
 * The dev server with no worked year in it.
 *
 * The seed writes a fictional Assembly with nine months of books, which is the
 * right default for working on almost every screen and exactly wrong for the
 * one screen that only exists when there are no books at all. This starts Vite
 * with the seed switched off, so `/` redirects to `/setup` the way it does on
 * a treasurer's first morning.
 *
 * Vite is started through its Node API rather than by setting an environment
 * variable in an npm script, because the shell syntax for that differs between
 * Windows and everywhere else and this project runs on both.
 */

process.env.BEDROCK_DEV_EMPTY = '1'

const { createServer } = await import('vite')

const server = await createServer()
await server.listen()
server.printUrls()
