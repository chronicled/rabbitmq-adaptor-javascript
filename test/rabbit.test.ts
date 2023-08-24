/*
 * This is a simple test that initializes exchanges, queues and bindings in RabbitMQ
 * and tests if the publish and subscribe work properly.
 *
 * Assumption: This test will only run if RabbitMQ server is running and the AMQP_URI
 * field is set in the config.
 */
import 'mocha';
import 'should';

import { ConsumeMessage } from 'amqplib';
import uuid from 'uuid/v4';

import { RabbitMQ, RabbitMQConnector } from '..';

const AMQP_URI = 'amqp://guest:guest@localhost:5672/';
const uniqueMessageId = uuid();
const exchangeName = 'testExchange';
const queueName = 'testQueue';

describe('Rabbit tests', () => {
  let rabbit: RabbitMQ;

  const timer = async (amount: number): Promise<void> =>
    new Promise(resolve => {
      setTimeout(resolve, amount);
    });

  before(async () => {
    rabbit = await new RabbitMQConnector().connect(AMQP_URI);
    await rabbit.createExchange(exchangeName);
    await rabbit.createQueue(queueName);
    await rabbit.bindQueue(exchangeName, queueName, 'BlockchainEvent.#');
    await timer(100);
  });

  after(async () => rabbit.close());

  // This test actually can't fail. Even if it throws, the try/catch in RabbitMQ::subscribe
  // will catch it. So this is kinda a silly test.
  function consumed(done: Mocha.Done) {
    return (data: ConsumeMessage | null) => {
      const {
        headers,
        messageId
        // @ts-ignore
      } = data.msg.properties;
      headers.should.deepEqual({ resourceId: 'abc123' });
      messageId.should.equal(uniqueMessageId);
      done();
    };
  }
  it('should consume messages from rabbitmq', done => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    rabbit.subscribe(queueName, consumed(done), true);
    const payload = { foo: 'bar' };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    rabbit.publish(
      exchangeName,
      'BlockchainEvent.Custody.MemberRegistered',
      payload,
      // @ts-ignore
      { resourceId: 'abc123' },
      uniqueMessageId
    );
  });
});
