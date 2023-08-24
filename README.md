# rabbitmq-adaptor-js

This is a repository that packages and exposes rabbitmq functions necessary as a platform library

All basic RabbitMQ functions are exposed in `index.ts`

To use this library you will need permissions to use Chronicled private npm registry. Once you have the credentials/token,

- `npm install @chronicled/rabbitmq-adaptor-js`

## Connecting

Connecting to RabbitMQ is done with the `connectMQ` function, and can be called with 0-1 arguments:

```ts
const rabbit = await connectMQ();
```

or

```ts
const rabbit = await connectMQ('amqp://localhost:5672');
```

If you call it in the first manner (preferred), it will default to the value you have in your `config-local.yaml` under `AMQP_URI`.

In either manner, it will return a `RabbitMQ` object.

## `RabbitMQ` object

In production, all queues, exchanges, and bindings will be made by [`platform-v2`](https://github.com/chronicled/platform-v2), so the only methods needed will be [`subscribe`](#subscribe) and [`publish`](#publish). The binding methods are only provided for development convenience. All functions are asynchronous.

### `RabbitMQ::subscribe(queue: string, onMessage: (msg: RabbitMQMessage) => any, options: SubscribeOptions = {})`

Attaches a message handler `onMessage` to `queue`. If `onMessage` throws an error, subscribe will automatically nack and requeue the message.

### `RabbitMQ::publish(exchange: string, routingKey: string, payload: any, headers: Options.Publish = {}, messageId: string)`

Publishes the given `payload` to the given `exchange` with the given `routingKey`. Optionally can set additional headers, or the `messageId`.

### `RabbitMQ::createQueue(name: string, options: CreateQueueOptions = {})`

Allows to create a queue. See [code](https://github.com/chronicled/rabbitmq-adaptor-js/blob/develop/lib/index.ts) for `CreateQueueOptions`.

### `RabbitMQ::createExchange(name: string, durable = true)`

Allows to create an exchange.

### `RabbitMQ::bindQueue(exchange: string, queue: string, topic: string)`

Bind a queue to an exchange with a specific routing key.

## Testing

- Ensure that rabbitmq is running locally. If not,

```sh
cd docker
docker-compose up
```

- Optional: to customize the rabbitmq address connected, copy the config-example.yaml to config-local.yaml and update AMQP_URI if needed.
- Now run `npm test` from root of the directory.
