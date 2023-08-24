FROM node:12

ENV PORT=8806
ENV BLUEBIRD_DEBUG=1

WORKDIR /app
COPY . /app
#Fixes bug where absence of file causes it to be mounted as directory
RUN if [ ! -f /app/config-local.yaml ]; then echo "{}" > /app/config-local.yaml; fi

EXPOSE 8806
CMD ["npm", "dist/server.js"]
