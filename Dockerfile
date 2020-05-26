FROM node:lts-alpine

LABEL name "lolisafe"
LABEL version "3.0.0"
LABEL maintainer "iCrawl <icrawltogo@gmail.com>"

WORKDIR /usr/src/lolisafe

COPY package.json yarn.lock ./

RUN apk add --no-cache --virtual build-dependencies python make g++

RUN apk add --no-cache ffmpeg

RUN yarn install

RUN apk update

RUN apk del build-dependencies

COPY . .
EXPOSE 9999
CMD ["node", "lolisafe.js"]
