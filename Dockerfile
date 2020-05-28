FROM node:lts-alpine

LABEL name "lolisafe-bobbywibowo"
LABEL version "3.0.0"
LABEL maintainer "evanmn <docker@evan.mn>"

WORKDIR /usr/src/lolisafe

COPY package.json yarn.lock ./

RUN apk add --no-cache --virtual build-dependencies python make g++ && apk add --no-cache ffmpeg

ADD config.sample.js config.js

RUN yarn install

RUN apk update

RUN apk del build-dependencies

COPY . .
EXPOSE 9999
CMD ["node", "lolisafe.js"]
