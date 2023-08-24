/*
 * This is a simple test that initializes exchanges, queues and bindings in RabbitMQ
 * and tests if the publish and subscribe work properly.
 *
 * Assumption: This test will only run if RabbitMQ server is running and the AMQP_URI
 * field is set in the config.
 */

const rabbit = require('../lib');
const Bluebird = require('bluebird');
const _ = require('lodash');
const AMQP_URI = 'amqp://guest:guest@localhost:5672/';
const uuid = require('uuid/v4');
const messageId = uuid();
const exchangeName = 'testExchange';
const queueName = 'testQueue';

Bluebird.resolve(rabbit.connect(AMQP_URI))
  .then(() => rabbit.createExchange(exchangeName))
  .then(() => rabbit.createQueue(queueName))
  .then(() => rabbit.bindQueue(exchangeName, queueName, 'BlockchainEvent.#'))
  .then(() => {
    return setTimeout(() => {
      rabbit.subscribe(queueName, consumed, true);
      const payload = { foo: 'bar' };
      rabbit.publish(exchangeName, 'BlockchainEvent.Custody.MemberRegistered', payload, { 'resourceId': 'abc123' }, messageId);
      return setTimeout(() => rabbit.close(), 100);
    }, 100);
  });

function consumed(data) {
  /* eslint-disable no-console */
  console.log('Consumed: ', data);
  const isCorrectHeader = _.isEqual({ 'resourceId': 'abc123' }, data.msg.properties.headers);
  const isCorrectMessageId = _.isEqual(messageId, data.msg.properties.messageId);
  console.log('\n Got the right headers: ', isCorrectHeader);
  console.log('\n Got correct message id: ', isCorrectMessageId);
}
