const { createServer } = require('http')
const { WebSocketServer } = require('ws')
const { createYoga, createSchema } = require('graphql-yoga')
const { useServer } = require('graphql-ws/lib/use/ws')
const { parse } = require('url')
const next = require('next')
const { PubSub } = require('graphql-subscriptions');

const pubsub = new PubSub();
 
const dev = process.env.NODE_ENV !== 'production'
const hostname = 'localhost'
const port = 3000
 
// prepare nextjs
const app = next({ dev, hostname, port })
 
// match the route next would use if yoga was in `pages/api/graphql.ts`
const graphqlEndpoint = '/api/graphql'

let counter = 0
 
// prepare yoga
const yoga = createYoga({
  graphqlEndpoint,
  graphiql: {
    subscriptionsProtocol: 'WS'
  },
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        hello: String!
        clock: String!
        counter: Int!
      }
      type Subscription {
        clock: String!
        counter: Int!
        countdown(from: Int!): Int!
      }
    `,
    resolvers: {
      Query: {
        hello: () => 'world',
        clock: () => new Date().toString(),
        counter: () => counter
      },
      Subscription: {
        clock: {
          subscribe: () => pubsub.asyncIterator(['CLOCK']),
        },
        counter: {
          subscribe: () => pubsub.asyncIterator(['COUNTER']),
        },
        countdown: {
          // This will return the value on every 1 sec until it reaches 0
          subscribe: async function* (_, { from }) {
            for (let i = from; i >= 0; i--) {
              await new Promise(resolve => setTimeout(resolve, 1000))
              yield { countdown: i }
            }
          }
        }
      }
    }
  })
})
 
;(async () => {
  await app.prepare()
  const handle = app.getRequestHandler()
 
  // create http server
  const server = createServer(async (req, res) => {
    try {
      // Be sure to pass `true` as the second argument to `url.parse`.
      // This tells it to parse the query portion of the URL.
      const url = parse(req.url, true)
 
      if (url.pathname.startsWith(graphqlEndpoint)) {
        await yoga(req, res)
      } else {
        await handle(req, res, url)
      }
    } catch (err) {
      console.error(`Error while handling ${req.url}`, err)
      res.writeHead(500).end()
    }
  })
 
  // create websocket server
  const wsServer = new WebSocketServer({ server, path: graphqlEndpoint })
 
  // prepare graphql-ws
  useServer(
    {
      execute: args => args.rootValue.execute(args),
      subscribe: args => args.rootValue.subscribe(args),
      onSubscribe: async (ctx, msg) => {
        const { schema, execute, subscribe, contextFactory, parse, validate } = yoga.getEnveloped({
          ...ctx,
          req: ctx.extra.request,
          socket: ctx.extra.socket,
          params: msg.payload
        })
 
        const args = {
          schema,
          operationName: msg.payload.operationName,
          document: parse(msg.payload.query),
          variableValues: msg.payload.variables,
          contextValue: await contextFactory(),
          rootValue: {
            execute,
            subscribe
          }
        }
 
        const errors = validate(args.schema, args.document)
        if (errors.length) return errors
        return args
      }
    },
    wsServer
  )
 
  await new Promise((resolve, reject) =>
    server.listen(port, err => (err ? reject(err) : resolve()))
  )
 
  console.log(`
> App started!
  HTTP server running on http://${hostname}:${port}
  GraphQL WebSocket server running on ws://${hostname}:${port}${graphqlEndpoint}
`)
})()

function updateClock() {
  pubsub.publish('CLOCK', { clock: new Date().toString() });
  setTimeout(updateClock, 1000);
}

function updateCounter() {
  counter += 1
  pubsub.publish('COUNTER', { counter });
  setTimeout(updateCounter, 1000);
}

updateClock();
updateCounter();