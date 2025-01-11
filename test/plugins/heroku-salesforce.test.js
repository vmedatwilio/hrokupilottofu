'use strict'

const { test } = require('tap')
const Fastify = require('fastify')
const HerokuSalesforcePlugin = require('../../src/plugins/heroku-salesforce')

test('support works standalone', async (t) => {
  const fastify = Fastify()
  fastify.register(HerokuSalesforcePlugin)

  await fastify.ready()
  t.equal(fastify.someSupport(), 'hugs')
});