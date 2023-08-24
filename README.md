# rabbitmq-standalone
This is a repository that packages and exposes rabbitmq functions necessary as a platform library

All basic RabbitMQ functions are exposed in `lib/index.js`

To use this library you will need permissions to use Chronicled private npm registry. Once you have the credentials/token,
- `npm install @chronicled/rabbitmq-adaptor-js`
- require('@chronicled/rabbitmq-adaptor-js') in your application

To test,
- Ensure that rabbitmq is running locally. If not, run `docker run -p "5672:5672" -p "15672:15672" rabbitmq:3-management`
- Copy the config-example.yaml to config-local.yaml and update AMQP_URI if needed
- Now run `node test/rabbit_test.js` from root of the directory
