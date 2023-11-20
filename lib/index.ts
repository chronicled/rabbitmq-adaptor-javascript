import _ from 'lodash';
import { v4 as uuid } from 'uuid';
import {
  ConfirmChannel,
  connect,
  Connection,
  ConsumeMessage,
  MessagePropertyHeaders,
  Options,
  Replies
} from 'amqplib';
import {
  Config,
  Logger,
  currentCorrelationContext,
  withCorrelationContext
} from '@chronicled/platform-utils-js';

/**
 * Legacy method. Prefer instantiating the object directly and awaiting connect.
 */
export async function connectMQ(
  url: string = Config.get('AMQP_URI')
): Promise<RabbitMQ> {
  try {
    const rabbit = new RabbitMQ(null, null, url);
    await rabbit.connect();
    Logger.debug('RabbitMQ: Successfully connected', { url });
    return rabbit;
  } catch (error) {
    Logger.error('RabbitMQ: Error while creating channel', error);
    throw error;
  }
}

export class RabbitMQ {
  private readonly handlers: Map<string, SubsrcribeArguments> = new Map();
  isDrained = true;
  isConnecting: Promise<void> | null = null;
  isReconnecting: Promise<void> | null = null;
  isErroring = false;

  constructor(
    public connection: Connection | null = null,
    public channel: ConfirmChannel | null = null,
    private readonly url: string = Config.get('AMQP_URI')
  ) {}

  connect(): Promise<void> {
    if (!this.isConnecting) {
      this.isConnecting = this.doConnect();
    }

    return this.isConnecting;
  }

  async doConnect(): Promise<void> {
    if (this.connection) {
      await this.close();
    }

    Logger.debug('RabbitMQ: Connecting');

    try {
      this.connection = await connect(this.url);
    } catch (e) {
      this.isConnecting = null;
      throw e;
    }

    this.connection.on('error', (err: Error) => {
      this.isErroring = true;
      Logger.error('RabbitMQ: Error in connection', err);
      this.reconnect();
    });

    try {
      this.channel = await this.connection.createConfirmChannel();
    } catch (e) {
      this.isConnecting = null;
      throw e;
    }

    this.channel.setMaxListeners(200);

    this.channel.on('drain', () => (this.isDrained = true));
    this.channel.on('error', (err: Error) => {
      this.isErroring = true;
      Logger.error('RabbitMQ: Error in channel', err);
      this.reconnect();
    });

    await this.reregister();

    this.isConnecting = null;
  }

  /**
   * @todo the reconnect method is leaving a dangling open connection behind possibly, this needs to be fixed
   */
  async reconnect(): Promise<void> {
    if (!this.isReconnecting) {
      this.isReconnecting = this.doReconnect();
    }

    return this.isReconnecting;
  }

  /**
   * Reconnect with an exponential delay in case of error
   */
  async doReconnect(): Promise<void> {
    Logger.debug('RabbitMQ: Reconnecting');

    const maxWaitSeconds = Config.getWithDefault(
      'RABBIT_MAX_RETRY_INTERVAL_SECONDS',
      32
    );
    const retryBaseSecond = 2;
    let retryCount = 0;

    while (true) {
      const waitSeconds = Math.min(
        Math.pow(retryBaseSecond, Math.min(retryCount, 15)),
        maxWaitSeconds
      );

      try {
        await this.connect();
        break;
      } catch (error) {
        Logger.error(
          `RabbitMQ: Error while reconnecting. Waiting ${waitSeconds} seconds before trying again`,
          error
        );
        retryCount += 1;
        await sleep(waitSeconds * 1000);
      }
    }

    Logger.debug('RabbitMQ: Successfully reconnected');
    this.isErroring = false;
    this.isReconnecting = null;
  }

  reregister(): Promise<Replies.Consume[]> {
    const registeringPromises: Promise<Replies.Consume>[] = [];

    this.handlers.forEach((value, key) => {
      const { name, onMessage, options, assertQueue } = value;
      registeringPromises.push(
        this.subscribe(
          name,
          onMessage,
          _.extend(options, { consumerTag: key }),
          assertQueue
        )
      );
    });

    return Promise.all(registeringPromises);
  }

  assertChannel(
    channel: ConfirmChannel | null
  ): asserts channel is ConfirmChannel {
    if (!channel) {
      throw new Error('Channel is undefined, did you call `connect`?');
    }
  }

  async createExchange(name: string, durable = true): Promise<void> {
    this.assertChannel(this.channel);

    const { exchange } = await this.channel.assertExchange(name, 'topic', {
      durable
    });

    if (name === exchange) {
      await this.channel.checkExchange(name);
      Logger.debug('RabbitMQ: Exchange created/asserted', { name });
    } else {
      this.raise(`Could not instantiate exchange ${name}`);
    }
  }

  async createQueue(
    name: string,
    options: CreateQueueOptions = {}
  ): Promise<void> {
    const {
      durable = true,
      enableDeadLetterExchange = false,
      prefetch = 0
    } = options;
    this.assertChannel(this.channel);

    const deadExchangeName = `${name}.dead`;
    if (enableDeadLetterExchange) {
      await this.createExchange(deadExchangeName);
    }
    const args = {
      'x-dead-letter-exchange': deadExchangeName
    };
    const { queue }: Replies.AssertQueue = await this.channel.assertQueue(
      name,
      { durable, ...args }
    );

    await this.channel.prefetch(prefetch);

    if (name === queue) {
      await this.channel.checkQueue(name);
      Logger.debug('RabbitMQ: Queue created/asserted', { name });
    } else {
      this.raise(`Could not instantiate queue ${name}`);
    }
  }

  deleteQueue(name: string): Promise<Replies.DeleteQueue> {
    this.assertChannel(this.channel);
    return this.channel.deleteQueue(name);
  }

  private async _safePublish(
    exchange: string,
    routingKey: string,
    buffer: Buffer,
    options: Options.Publish = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.assertChannel(this.channel);

      const onError = (error: Error): void => reject(error);

      const doPublish = (): void => {
        this.assertChannel(this.channel);

        // Rely on publish mechanism from now on
        this.channel.removeListener('error', onError);

        this.isDrained = this.channel.publish(
          exchange,
          routingKey,
          buffer,
          options,
          (err, _ok) => {
            if (err) {
              return reject(err);
            }
            return resolve();
          }
        );
      };

      if (this.isDrained) {
        doPublish();
      } else {
        this.channel.once('drain', doPublish);
      }

      this.channel.once('error', onError);
    });
  }

  async publish(
    exchange: string,
    routingKey: string,
    payload: any,
    options: Options.Publish = {}
  ): Promise<void> {
    const previousContext = currentCorrelationContext();
    const messageId = options.messageId ?? uuid();
    const correlationContext = {
      correlationId: previousContext?.correlationId ?? options.correlationId,
      causationId: previousContext?.messageId,
      messageId
    };

    options.messageId = correlationContext?.messageId;
    options.headers = {
      ...(options.headers || {}),
      'correlation-id': correlationContext?.correlationId,
      'causation-id': correlationContext?.causationId
    };
    options.persistent = true;

    return withCorrelationContext(correlationContext, async () => {
      try {
        const str = JSON.stringify(payload);
        const buffer = Buffer.from(str);

        await this._safePublish(exchange, routingKey, buffer, options);

        Logger.trace('RabbitMQ: Published message', {
          exchange: exchange,
          routingKey: routingKey,
          data: str,
          headers: options.headers
        });
      } catch (err: any) {
        this.raise('Error while publishing', err);
      }
    });
  }

  async subscribe<P extends {}, H extends CustomHeaders>(
    name: string,
    onMessage: OnMessageHandler<P, H>,
    options: SubscribeOptions = {},
    assertQueue: boolean = false
  ): Promise<Replies.Consume> {
    const {
      ack = true,
      prefetch = 0,
      requeue = true,
      consumerTag = undefined
    } = options;

    if (assertQueue) {
      try {
        await this.createQueue(name, { prefetch });
      } catch (err) {
        Logger.error(`RabbitMQ: Error in subscribe for queue ${name}`, err);
      }
    }

    try {
      this.assertChannel(this.channel);

      // Set a prefetch for the channel
      await this.channel.prefetch(prefetch);

      const consumer = await this.channel.consume(
        name,
        this.onMessageWrapper(onMessage, { name, ack, requeue }),
        { noAck: !ack, consumerTag }
      );

      this.handlers.set(consumer.consumerTag, {
        name,
        onMessage: onMessage as OnMessageHandler<P, CustomHeaders>,
        options,
        assertQueue
      });

      return consumer;
    } catch (err: any) {
      this.raise('Error in subscribe', err);
    }
  }

  unsubscribeAll(): Promise<void[]> {
    const unsubscribePromises: Promise<void>[] = [];

    this.handlers.forEach((_val, key) => {
      unsubscribePromises.push(this.unsubscribeTag(key));
    });

    return Promise.all(unsubscribePromises);
  }

  unsubscribe(consumer: Replies.Consume): Promise<void> {
    return this.unsubscribeTag(consumer.consumerTag);
  }

  async unsubscribeTag(tag: string): Promise<void> {
    this.assertChannel(this.channel);
    await this.channel.cancel(tag);
    this.handlers.delete(tag);
  }

  pause(): Promise<Replies.Empty[]> {
    Logger.debug('RabbitMQ: Pausing connection');

    this.assertChannel(this.channel);
    const pausePromises: Promise<Replies.Empty>[] = [];

    for (const [key] of this.handlers) {
      pausePromises.push(this.channel.cancel(key));
    }

    return Promise.all(pausePromises);
  }

  resume(): Promise<Replies.Consume[]> {
    Logger.debug('RabbitMQ: Resuming connection');
    return this.reregister();
  }

  private onMessageWrapper<P extends {}, H extends CustomHeaders>(
    onMessage: OnMessageHandler<P, H>,
    { name, ack, requeue }: OnMessageWrapperOptions
  ) {
    return async (msg: ConsumeMessage | null) => {
      const payload = msg && this.getJSON<P>(msg.content, name);
      if (_.isNull(msg) || _.isNull(payload)) {
        return;
      }

      const inputMessage = {
        body: msg.content.toString(),
        properties: msg.properties,
        fields: msg.fields
      };
      const messageId = msg.properties.messageId;
      const headers = msg.properties.headers as H;
      const { 'correlation-id': correlationId, 'causation-id': causationId } =
        headers;

      return withCorrelationContext(
        { correlationId, causationId, messageId, inputMessage },
        async () => {
          Logger.trace('RabbitMQ: Incoming message', {
            queueName: name,
            body: msg.content.toString(),
            properties: msg.properties,
            fields: msg.fields
          });

          this.assertChannel(this.channel);

          const { routingKey } = msg.fields;

          try {
            await onMessage({
              payload,
              routingKey,
              msg,
              headers,
              queue: name,
              messageId
            });

            if (ack) {
              this.channel.ack(msg);
            }
          } catch (err) {
            Logger.error('RabbitMQ: Error in message handling', {
              queueName: name,
              err
            });

            if (ack) {
              this.channel.nack(msg, false, requeue);
            }
          }
        }
      );
    };
  }

  async bindQueue(
    exchange: string,
    queue: string,
    topic: string
  ): Promise<void> {
    this.assertChannel(this.channel);

    await this.channel.bindQueue(queue, exchange, topic);

    Logger.debug(
      `RabbitMQ: Queue ${queue} bound to ${exchange}, topic ${topic}`
    );
  }

  async close(): Promise<void> {
    Logger.debug('RabbitMQ: Closing');

    try {
      await this.unsubscribeAll();
      if (this.channel) {
        await this.channel.close();
      }
    } catch (err) {
      if (!(err as Error).message.includes('Channel closed')) {
        Logger.error('RabbitMQ: error closing channel', err);
      }
    } finally {
      this.channel = null;
    }

    try {
      if (this.connection) {
        await this.connection.close();
      }
    } catch (err) {
      Logger.error('RabbitMQ: error closing connection', err);
    } finally {
      this.connection = null;
    }
  }

  getJSON<A>(content: Buffer, name: string): A | null {
    try {
      return JSON.parse(content.toString());
    } catch (__) {
      Logger.error('RabbitMQ: Invalid JSON', {
        queueName: name,
        content: content.toString()
      });
      return null;
    }
  }

  raise(msg: string, err?: Error): never {
    Logger.error('RabbitMQ: ' + msg, err);
    throw err || new Error(msg);
  }
}

interface Dictionary<T> {
  [key: string]: T;
}
export type CustomHeaders = Dictionary<string>;

export interface RabbitMQMessage<
  Content extends {} = {},
  Headers extends CustomHeaders = CustomHeaders
> {
  payload: Content;
  routingKey: string;
  msg: ConsumeMessage;
  queue: string;
  headers: MessagePropertyHeaders & Headers;
  messageId: string;
}

export type CreateQueueOptions = {
  durable?: boolean;
  prefetch?: number;
  enableDeadLetterExchange?: boolean;
  arguments?: object;
} & {
  [other: string]: any;
};
export interface SubscribeOptions {
  ack?: boolean;
  prefetch?: number;
  requeue?: boolean;
  consumerTag?: string | undefined;
}

export type OnMessageHandler<
  P extends {},
  H extends CustomHeaders = CustomHeaders
> = (msg: RabbitMQMessage<P, H>) => void | Promise<void>;

export interface SubsrcribeArguments<
  P extends {} = any,
  H extends CustomHeaders = CustomHeaders
> {
  name: string;
  onMessage: OnMessageHandler<P, H>;
  options: SubscribeOptions;
  assertQueue: boolean;
  consumerTag?: string | undefined;
}

interface OnMessageWrapperOptions {
  name: string;
  ack: boolean;
  requeue: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
