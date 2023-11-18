/*
 * This is a simple test that initializes exchanges, queues and bindings in RabbitMQ
 * and tests if the publish and subscribe work properly.
 *
 * Assumption: This test will only run if RabbitMQ server is running and the AMQP_URI
 * field is set in the config.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import 'mocha';
import * as fs from 'fs';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import delay from 'delay';
import { connectMQ, RabbitMQ, RabbitMQMessage } from '../lib';
import { withCorrelationContext, Logger } from '@chronicled/platform-utils-js';

chai.use(chaiAsPromised);
chai.should();

Logger.silent = true;

const AMQP_URI = 'amqp://guest:guest@localhost:5672/';
const exchangeName = 'testExchange';
const queueName = 'testQueue';
const correlationContext = {
  correlationId: 'correlation-id',
  causationId: 'causation-id',
  messageId: 'message-id'
};

class AsyncDone {
  promise: Promise<void>;
  _resolve: (() => void) | undefined;
  _reject: ((error?: any) => void) | undefined;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolve(): void {
    if (this._resolve) {
      this._resolve();
    } else {
      throw new Error(
        "AsyncDone did not have it's _resolve field properly set"
      );
    }
  }

  reject(error?: any): void {
    if (this._reject) {
      this._reject(error);
    } else {
      throw new Error("AsyncDone did not have it's _reject field properly set");
    }
  }
}

describe('Rabbit tests', (): void => {
  let rabbit: RabbitMQ;

  before(async () => {
    const _rabbit = await connectMQ(AMQP_URI);
    await _rabbit.createExchange(exchangeName);
    await _rabbit.createQueue(queueName);
    await _rabbit.bindQueue(exchangeName, queueName, 'BlockchainEvent.#');
    await _rabbit.close();
  });

  beforeEach(async () => {
    rabbit = await connectMQ(AMQP_URI);
  });

  afterEach(async () => {
    await rabbit.close();
  });

  it('should consume messages from rabbitmq', async () => {
    const payload = { foo: 'bar' };
    const routing = 'BlockchainEvent.Custody.MemberRegistered';
    const messageId = 'new-message-id';
    const done = new AsyncDone();

    function consumed(msg: RabbitMQMessage<typeof payload>): void {
      try {
        msg.headers.should.deep.equal({
          'correlation-id': correlationContext?.correlationId,
          'causation-id': correlationContext?.messageId
        });
        msg.messageId.should.equal(messageId);
        msg.payload.should.deep.equal(payload);
        msg.routingKey.should.equal(routing);
        done.resolve();
      } catch (error) {
        done.reject(error);
      }
    }

    await rabbit.subscribe(queueName, consumed);

    await withCorrelationContext(correlationContext, async () => {
      await rabbit.publish(exchangeName, routing, payload, { messageId });
    });

    return done.promise;
  });

  it('should not allow subscribing to a non-existent queue', async () => {
    await chai
      .expect(rabbit.subscribe('bad-q', console.log))
      .to.be.rejectedWith(Error);

    await rabbit.reconnect();

    await rabbit.createQueue('bad-q');
    await rabbit.subscribe('bad-q', console.log);
    return rabbit.deleteQueue('bad-q');
  });

  it('should reconnect after an error', async () => {
    await chai
      .expect(rabbit.subscribe('bad-q', console.log))
      .to.eventually.be.rejectedWith(Error);

    await rabbit.reconnect();

    // Creating a queue is only possible after reconnect
    await rabbit.createQueue('bad-q');
    return rabbit.deleteQueue('bad-q');
  });

  it('should reregister handler after an error', async () => {
    const payload = { foo: 'bar' };
    const messageId = 'new-message-id';
    const routing = 'BlockchainEvent.Custody.MemberRegistered';
    const done = new AsyncDone();

    function consumed(msg: RabbitMQMessage<typeof payload>): void {
      try {
        msg.headers.should.deep.equal({
          'correlation-id': correlationContext?.correlationId,
          'causation-id': correlationContext?.messageId
        });
        msg.messageId.should.equal(messageId);
        msg.payload.should.deep.equal(payload);
        msg.routingKey.should.equal(routing);
        done.resolve();
      } catch (error) {
        done.reject(error);
      }
    }

    await rabbit.subscribe(queueName, consumed);

    await chai
      .expect(rabbit.subscribe('bad-q', console.log))
      .to.eventually.be.rejectedWith(Error);

    await rabbit.reconnect();

    await withCorrelationContext(correlationContext, async () => {
      await rabbit.publish(exchangeName, routing, payload, { messageId });
    });

    return done.promise;
  });

  it('should wait for drain events', async () => {
    const bigContent = fs.readFileSync('./test/bigContent.fixture', {
      encoding: 'utf8'
    });
    const payload = { foo: bigContent };
    const routing = 'BlockchainEvent.Custody.MemberRegistered';
    const messageId = 'new-message-id';
    const drainEventReceivedDone = new AsyncDone();

    let messagesReceived = 0;

    function consumed(_msg: RabbitMQMessage<typeof payload>): void {
      messagesReceived += 1;
    }

    function receivedDrain(): void {
      drainEventReceivedDone.resolve();
    }

    rabbit.assertChannel(rabbit.channel);
    rabbit.channel.once('drain', receivedDrain);

    await rabbit.subscribe(queueName, consumed);

    const messagePromises: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      messagePromises.push(
        withCorrelationContext(correlationContext, () =>
          rabbit.publish(exchangeName, routing, payload, {
            messageId: `${messageId}-${i}`
          })
        )
      );
    }

    await Promise.all([drainEventReceivedDone.promise, ...messagePromises]);

    await delay(100);

    messagesReceived.should.equal(messagePromises.length);
  }).timeout(20000);

  it('should pause and resume rmq message processing', async () => {
    var received = 0;
    const subscription = await rabbit.subscribe(queueName, (_msg) => {
      received++;
    });
    await rabbit.pause();
    await rabbit.publish(
      exchangeName,
      'BlockchainEvent.Custody.MemberRegistered',
      { key: 'val' }
    );
    await delay(100);
    received.should.equal(0);
    await rabbit.resume();
    await delay(100);
    received.should.equal(1);
    return rabbit.unsubscribe(subscription);
  }).timeout(5000);

  describe('nack tests', (): void => {
    const routing = 'BlockchainEvent.Custody.MemberRegistered';

    type Stage = 'INIT' | 'NACK' | 'SUCCESS';
    class FailOnce {
      stage: Stage = 'INIT';

      constructor(private readonly done: AsyncDone) {}

      step = (): void => {
        if (this.stage === 'INIT') {
          this.stage = 'NACK';

          throw new Error('this should trigger a nack');
        } else if (this.stage === 'NACK') {
          this.stage = 'SUCCESS';
          this.done.resolve();
        }
      };

      sync = this.step;

      asynch = async (): Promise<void> => Promise.resolve().then(this.step);
    }

    it('should nack when a handler fails', async () => {
      const done = new AsyncDone();

      await rabbit.subscribe(queueName, new FailOnce(done).sync);

      await rabbit.publish(exchangeName, routing, {});

      return done.promise;
    });

    it('should nack when a handler fails asynchronously', async () => {
      const done = new AsyncDone();

      await rabbit.subscribe(queueName, new FailOnce(done).asynch);

      await rabbit.publish(exchangeName, routing, {});
      return done.promise;
    });
  });
});
