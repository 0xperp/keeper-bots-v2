FROM public.ecr.aws/bitnami/node:18
RUN apt-get install git
ENV NODE_ENV=production

RUN npm install -g yarn
RUN npm install -g typescript
RUN npm install -g -D ts-node

WORKDIR /app
COPY . .
RUN yarn
RUN yarn build

EXPOSE 9464

# CMD [ "yarn", "start:all" ]
CMD [ "yarn", "dev:jitmaker"]
