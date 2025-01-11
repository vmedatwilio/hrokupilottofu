'use strict';

const fastify = require('fastify')();
const path = require('node:path');
const AutoLoad = require('@fastify/autoload');
const Swagger = require('@fastify/swagger');
const SwaggerUI = require('@fastify/swagger-ui');

// Pass --options via CLI arguments in command to enable these options.
const options = {};

// Register plugins and routes
async function buildApp() {
    // Place here your custom code!
    fastify.register(Swagger, {
        mode: 'static',
        specification: {
            path: './api-spec.yaml'
        },
        exposeRoute: true
    });

    fastify.register(SwaggerUI, {
        routePrefix: '/api-docs',
    });

    // Do not touch the following lines
    // This loads all plugins defined in plugins
    // those should be support plugins that are reused
    // through your application
    fastify.register(AutoLoad, {
        dir: path.join(__dirname, 'plugins'),
        options: Object.assign({}, options)
    });

    // This loads all plugins defined in routes
    // define your routes in one of these
    fastify.register(AutoLoad, {
        dir: path.join(__dirname, 'routes'),
        options: Object.assign({}, options)
    });

    return fastify;
}

(async () => {
    try {
        const PORT = process.env.PORT || 3000; // Use PORT from Heroku or default to 3000
        const app = await buildApp();

        // Start the server
        app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
            if (err) {
                console.error(err);
                process.exit(1);
            }
            console.log(`Server is running at ${address}`);
        });
    } catch (err) {
        console.error('Error starting server:', err);
        process.exit(1);
    }
})();