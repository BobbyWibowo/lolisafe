#Build from Debian/Ubuntu source, but its more stable.
FROM node:latest

LABEL name "lolisafe-bobbywibowo"
LABEL version "3.0.0"
LABEL maintainer "evanmn <docker@evan.mn>"

WORKDIR /usr/src/lolisafe

COPY package.json yarn.lock ./

RUN apt update
RUN apt install -y python python3 make g++ git ffmpeg
RUN yarn install --production
RUN yarn cache clean
RUN apt clean

ADD config.sample.js config.js

COPY . .

EXPOSE 9999

#First migrate then start the Safe. Why? When you auto-Deploy the container, its easier to update.
CMD ["/bin/bash", "start.sh"]