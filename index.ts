import { Logger } from '@chronicled/platform-utils-js';
import amqp, {
  Channel,
  Connection,
  ConsumeMessage,
  Options,
  Replies
} from 'amqplib';
import _ from 'lodash';
import uuid from 'uuid/v4';

export class RabbitMQConnector {
  async connect(url: string): Promise<RabbitMQ> {
    try {
      const connection = await amqp.connect(url);

      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      process.once('SIGINT', this.close(connection));

      const channel = await connection.createChannel();
      Logger.debug('RabbitMQ: successfully connected to ', url);

      return new RabbitMQ(connection, channel);
    } catch (err) {
      Logger.error('RabbitMQ: Error while creating channel\n', err);
      throw err;
    }
  }

  private readonly close = (connection: Connection) => async () => {
    await connection.close();
    process.exit();
  };
}

export class RabbitMQ {
  constructor(
    private readonly connection: Connection,
    private readonly channel: Channel
  ) {}

  createExchange = async (name: string, durable = true): Promise<void> => {
    const { exchange } = await this.channel.assertExchange(name, 'topic', {
      durable
    });

    if (name === exchange) {
      await this.channel.checkExchange(name);
      Logger.debug(`RabbitMQ: Exchange ${name} created/asserted`);
    } else {
      this.raise(`RabbitMQ: Could not instantiate exchange ${name}`);
    }
  };

  createQueue = async (
    name: string,
    durable = true,
    enableDeadLetterExchange = false,
    prefetch = 0
  ): Promise<void> => {
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
      Logger.debug(`RabbitMQ: Queue ${name} created/asserted`);
    } else {
      this.raise(`RabbitMQ: Could not instantiate queue ${name}`);
    }
  };

  publish = async (
    name: string,
    routingKey: string,
    payload: any,
    headers: Options.Publish = {},
    messageId = uuid()
  ): Promise<void> => {
    const buffer = Buffer.from(JSON.stringify(payload));
    try {
      await this.channel.publish(name, routingKey, buffer, {
        headers,
        messageId
      });

      Logger.debug(
        `RabbitMQ: Published message to exchange ${name} with routingKey ${routingKey} and messageId: ${messageId}`
      );
    } catch (err) {
      this.raise('Error in RabbitMQ publish: ', err);
    }
  };

  subscribe = async (
    name: string,
    onMessage: (msg: ConsumeMessage | null) => any,
    ack = true,
    prefetch = 0,
    requeue = true
  ): Promise<Replies.Consume> => {
    try {
      await this.createQueue(name, true, false, prefetch);
    } catch (err) {
      Logger.error(`RabbitMQ: Error in subscribe for queue ${name}`, err);
    }
    return this.channel.consume(
      name,
      this.onMessageWrapper(onMessage, name, ack, requeue),
      { noAck: !ack }
    );
  };

  private onMessageWrapper(
    onMessage: (msg: ConsumeMessage | null) => any,
    name: string,
    ack: boolean,
    requeue: boolean
  ) {
    return (msg: ConsumeMessage | null) => {
      const payload = msg && this.getJSON(msg.content, name);
      if (_.isNull(msg) || _.isNull(payload)) {
        return;
      }
      Logger.debug(
        'RabbitMQ: Incoming message on queue',
        name,
        ' with messageId: ',
        msg.properties.messageId
      );
      const { routingKey } = msg.fields;

      try {
        onMessage({
          // @ts-ignore
          payload,
          routingKey,
          msg,
          queue: name,
          headers: msg.properties
        });
        if (ack) {
          this.channel.ack(msg);
        }
      } catch (err) {
        Logger.error(
          `RabbitMQ: Error in consume callbackFunc for queue ${name}`,
          err
        );

        if (ack) {
          this.channel.nack(msg, false, requeue);
        }
      }
    };
  }

  async bindQueue(
    exchange: string,
    queue: string,
    topic: string
  ): Promise<void> {
    await this.channel.bindQueue(queue, exchange, topic);

    Logger.debug(
      `RabbitMQ: Queue ${queue} bound to ${exchange}, topic ${topic}`
    );
  }

  close = async (): Promise<void> => {
    Logger.debug('RabbitMQ: Closing connection.');
    try {
      await this.channel.close();
    } catch (err) {
      Logger.error('RabbitMQ: error closing connection', err);
    } finally {
      await this.connection.close();
    }
  };

  getJSON(content: Buffer, name: string): string | null {
    try {
      return JSON.parse(content.toString());
    } catch (__) {
      Logger.error(
        'RabbitMQ: Consumed message on queue',
        name,
        'not a valid JSON: ',
        content.toString()
      );
      return null;
    }
  }

  raise(...msgs: string[]): never {
    Logger.error(...msgs);
    throw new Error(...msgs);
  }
}
