const { Logger } = require('@chronicled/platform-utils-js');
const amqp = require('amqplib');
const Bluebird = require('bluebird');
const uuid = require('uuid/v4');
const _ = require('lodash');

class RabbitMQ {
  connect(url) {
    const connP = amqp.connect(url);
    return Bluebird.resolve(connP)
      .then(conn => {
        const exit = () => {
          conn.close.bind(conn)();
          process.exit();
        };
        process.once('SIGINT', exit);
        this.connection = conn;
        return conn.createChannel();
      })
      .then(ch => {
        Logger.debug('RabbitMQ: successfully connected to ', url);
        this.channel = ch;
      })
      .tapCatch(err => Logger.error('RabbitMQ: Error while creating channel\n', err));
  }

  createExchange(name, durable = true) {
    return this.channel.assertExchange(name, 'topic', { durable })
      .then(eok => {
        return name === eok.exchange ? this.channel.checkExchange(name) : Bluebird.reject(new Error(`RabbitMQ: Could not instantiate exchange ${name}`));
      })
      .then(() => Logger.debug(`RabbitMQ: Exchange ${name} created/asserted`));
  }

  createQueue(name, durable = true, enableDeadLetterExchange = false, prefetch = 0) {
    const deadExchangeName = name + '.dead';
    if (enableDeadLetterExchange) {
      this.createExchange(deadExchangeName);
    }
    const args = {
      'x-dead-letter-exchange': deadExchangeName
    };
    return this.channel.assertQueue(name, { durable, args })
      .then(qok => {
        this.channel.prefetch(prefetch);
        return name === qok.queue ? this.channel.checkQueue(name) : Bluebird.reject(new Error(`RabbitMQ: Could not instantiate queue ${name}`));
      })
      .then(() => Logger.debug(`RabbitMQ: Queue ${name} created/asserted`));
  }

  publish(name, routingKey, payload, headers = {}, messageId = null) {
    const buffer = Buffer.from(JSON.stringify(payload));
    Logger.debug(`RabbitMQ: Publishing message to exchange ${name} with routingKey ${routingKey}`);
    return this.channel.publish(name, routingKey, buffer, { headers, 'messageId': _.isNull(messageId) ? uuid() : messageId });
  }

  consume(name, callbackFunc, ack = true, prefetch = 0, requeue = true) {
    return this.createQueue(name, true, false, prefetch)
      .then(() => {
        return this.channel.consume(name, msg => {
          const payload = this.getJSON(msg.content, name);
          if (msg !== null && msg !== 'null' && payload !== null) {
            Logger.debug('RabbitMQ: Incoming message on queue', name);
            const { routingKey } = msg.fields;
            const { headers: customFields, ...restOfFields } = msg.properties;
            const headers = { ...restOfFields, ...customFields };

            return Bluebird.resolve(callbackFunc({ payload, routingKey, msg, queue: name, headers }))
              .then(() => ack ? this.channel.ack(msg) : undefined)
              .catch(err => ack ? this.channel.nack(msg, false, requeue) : Logger.error(`RabbitMQ: Error in consume callbackFunc for queue ${name}`, err));
          } else {
            // TODO: Error handling for nonJSON payloads. Curently just sending ACKs
            return this.channel.ack(msg);
          }
        }, { noAck: !ack });
      })
      .catch(err => Logger.error(`RabbitMQ: Error in subscribe for queue ${name}`, err));
  }

  bindQueue(exchange, queue, topic) {
    return this.channel.bindQueue(queue, exchange, topic)
      .then(() => Logger.debug(`RabbitMQ: Queue ${queue} bound to ${exchange}, topic ${topic}`));
  }

  close() {
    Logger.debug('RabbitMQ: Closing connection.');
    return this.channel.close()
      .finally(() => this.connection.close());
  }

  getJSON(content, name) {
    try {
      return JSON.parse(content.toString());
    } catch (__) {
      Logger.error('RabbitMQ: Consumed message on queue', name, 'not a valid JSON: ', content.toString());
      return null;
    }
  }
}

module.exports = RabbitMQ;
