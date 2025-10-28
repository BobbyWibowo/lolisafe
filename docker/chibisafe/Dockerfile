FROM node:18-bullseye

WORKDIR /usr/chibisafe
COPY package.json yarn.lock ./

RUN apt update &&\
apt install -y python python3 make g++ git ffmpeg && \
yarn install --production && \
yarn cache clean && \
apt clean

ADD config.sample.js config.js
ADD views/_globals.sample.njk views/_globals.njk

COPY . .
RUN mkdir uploads && mkdir database

CMD ["sh", "-c", "yarn migrate && yarn start"]
