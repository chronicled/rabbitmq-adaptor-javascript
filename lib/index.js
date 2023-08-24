const RabbitMQ = require('./rabbitmq');
const rabbit = new RabbitMQ();

module.exports = {
  connect: rabbit.connect.bind(rabbit),
  createExchange: rabbit.createExchange.bind(rabbit),
  createQueue: rabbit.createQueue.bind(rabbit),
  publish: rabbit.publish.bind(rabbit),
  subscribe: rabbit.consume.bind(rabbit),
  bindQueue: rabbit.bindQueue.bind(rabbit),
  close: rabbit.close.bind(rabbit)
};
