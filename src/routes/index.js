'use strict'

const { OpenAI } = require("openai");
const fs = require("fs-extra");
const path = require("path");

module.exports = async function (fastify, opts) {

    /**
     * Queries for and then returns all Accounts in the invoking org.
     *
     * If an org reference is set on SALESFORCE_ORG_NAME config var,
     * obtain the org's connection from the Heroku Integration add-on
     * and query Accounts in the target org.
     *
     * @param request
     * @param reply
     * @returns {Promise<void>}
     */
    fastify.get('/accounts', async function (request, reply) {
        const { event, context, logger } = request.sdk;

        logger.info(`GET /accounts: ${JSON.stringify(event.data || {})}`);

        if (process.env.SALESFORCE_ORG_NAME) {
            // If an org reference is set, query Accounts in that org
            const orgName = process.env.SALESFORCE_ORG_NAME;
            const herokuIntegration = request.sdk.addons.herokuIntegration;

            logger.info(`Getting ${orgName} org connection from Heroku Integration add-on...`);
            const anotherOrg = await herokuIntegration.getConnection(orgName);

            logger.info(`Querying org ${JSON.stringify(anotherOrg)} Accounts...`);
            try {
                const result = await anotherOrg.dataApi.query('SELECT Id, Name FROM Account');
                const accounts = result.records.map(rec => rec.fields);
                logger.info(`For org ${anotherOrg.id}, found the ${accounts.length} Accounts`);
            } catch (e) {
                logger.error(e.message);
            }
        }

        // Query invoking org's Accounts
        const org = context.org;
        logger.info(`Querying org ${org.id} Accounts...`);
        const result = await org.dataApi.query('SELECT Id, Name FROM Account');
        const accounts = result.records.map(rec => rec.fields);
        logger.info(`For org ${org.id}, found the following Accounts: ${JSON.stringify(accounts || {})}`);
        return accounts;
    });

    // Custom handler for async /unitofwork API that synchronously responds to request
    const unitOfWorkResponseHandler = async (request, reply) => {
        reply.code(201).send({'Code201': 'Received!', responseCode: 201});
    }

   /**
    * Asynchronous API that interacts with invoking org via External Service
    * callbacks defined in the OpenAPI spec.
    *
    * The API receives a payload containing Account, Contact, and Case
    * details and uses the unit of work pattern to assign the corresponding
    * values to its Record while maintaining the relationships. It then
    * commits the Unit of Work and returns the Record Id's for each object.
    *
    * The SDKs unit of work API is wrapped around Salesforce's Composite Graph API.
    * For more information on Composite Graph API, see:
    * https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_graph_introduction.htm
    *
    * The unitofworkResponseHandler function provides custom handling to sync'ly respond to the request.
    */
    fastify.post('/unitofwork',
        // async=true to apply standard response 201 response or provide custom response handler function
        {config: {salesforce: {async: unitOfWorkResponseHandler}}},
        async (request, reply) => {
            const { event, context, logger } = request.sdk;
            const org = context.org;
            const dataApi = context.org.dataApi;

            logger.info(`POST /unitofwork ${JSON.stringify(event.data || {})}`);

            const validateField = (field, value) => {
                if (!value) throw new Error(`Please provide ${field}`);
            }

            // Validate Input
            const data = event.data;
            validateField('accountName', data.accountName);
            validateField('lastName', data.lastName);
            validateField('subject', data.subject);

            // Create a unit of work that inserts multiple objects.
            const uow = dataApi.newUnitOfWork();

            // Register a new Account for Creation
            const accountId = uow.registerCreate({
                type: 'Account',
                fields: {
                    Name: data.accountName
                }
            });

            // Register a new Contact for Creation
            const contactId = uow.registerCreate({
                type: 'Contact',
                fields: {
                    FirstName: data.firstName,
                    LastName: data.lastName,
                    AccountId: accountId // Get the ReferenceId from previous operation
                }
            });

            // Register a new Case for Creation
            const serviceCaseId = uow.registerCreate({
                type: 'Case',
                fields: {
                    Subject: data.subject,
                    Description: data.description,
                    Origin: 'Web',
                    Status: 'New',
                    AccountId: accountId, // Get the ReferenceId from previous operation
                    ContactId: contactId // Get the ReferenceId from previous operation
                }
            });

            // Register a follow-up Case for Creation
            const followupCaseId = uow.registerCreate({
                type: 'Case',
                fields: {
                    ParentId: serviceCaseId, // Get the ReferenceId from previous operation
                    Subject: 'Follow Up',
                    Description: 'Follow up with Customer',
                    Origin: 'Web',
                    Status: 'New',
                    AccountId: accountId, // Get the ReferenceId from previous operation
                    ContactId: contactId // Get the ReferenceId from previous operation
                }
            });

            try {
                // Commit the Unit of Work with all the previous registered operations
                const response = await dataApi.commitUnitOfWork(uow);

                // Construct the result by getting the Id from the successful inserts
                const callbackResponseBody = {
                    accountId: response.get(accountId).id,
                    contactId: response.get(contactId).id,
                    cases: {
                        serviceCaseId: response.get(serviceCaseId).id,
                        followupCaseId: response.get(followupCaseId).id
                    }
                };

                const opts = {
                    method: 'POST',
                    body: JSON.stringify(callbackResponseBody),
                    headers: {'Content-Type': 'application/json'}
                }
                const callbackResponse = await org.request(data.callbackUrl, opts);
                logger.info(JSON.stringify(callbackResponse));
            } catch (err) {
                const errorMessage = `Failed to insert record. Root Cause : ${err.message}`;
                logger.error(errorMessage);
                throw new Error(errorMessage);
            }

            return reply;
    });

    /**
     * Handle Data Cloud data change event invoke as a Data Action Target
     * webhook.
     *
     * If a Data Cloud org reference is set on DATA_CLOUD_ORG config var
     * and a query string set on DATA_CLOUD_QUERY config var, obtain the
     * org's connection from the Heroku Integration add-on and query the
     * target org.
     *
     * API not included in api-spec.yaml as it is not invoked by a
     * Data Cloud Data Action Target webhook and not an External Service.
     *
     * For more information on Data Cloud data change event, see:
     * https://help.salesforce.com/s/articleView?id=sf.c360_a_data_action_target_in_customer_data_platform.htm&type=5
     */
    fastify.post('/handleDataCloudDataChangeEvent',
        {config: {salesforce: {parseRequest: false}}}, // Parsing is specific to External Service requests
        async function (request, reply) {
            const logger = request.log;
            const dataCloud = request.sdk.dataCloud;

            // REMOVE ME:
            logger.info(`x-signature: ${request.headers['x-signature']}`);

            if (!request.body) {
                logger.warn('Empty body, no events found');
                return reply.code(400).send();
            }

            const actionEvent = dataCloud.parseDataActionEvent(request.body);
            logger.info(`POST /dataCloudDataChangeEvent: ${actionEvent.count} events for schemas ${Array.isArray(actionEvent.schemas) && actionEvent.schemas.length > 0 ? (actionEvent.schemas.map((s) => s.schemaId)).join() : 'n/a'}`);

            // Loop thru event data
            actionEvent.events.forEach(evt => {
                logger.info(`Got action '${evt.ActionDeveloperName}', event type '${evt.EventType}' triggered by ${evt.EventPrompt} on object '${evt.SourceObjectDeveloperName}' published on ${evt.EventPublishDateTime}`);
                // Handle changed object values via evt.PayloadCurrentValue
            });

            // If config vars are set, query Data Cloud org
            if (process.env.DATA_CLOUD_ORG && process.env.DATA_CLOUD_QUERY) {
                const orgName = process.env.DATA_CLOUD_ORG;
                const query = process.env.DATA_CLOUD_QUERY;
                const herokuIntegration = request.sdk.addons.herokuIntegration;

                // Get DataCloud org connection from add-on
                logger.info(`Getting '${orgName}' org connection from Heroku Integration add-on...`);
                const org = await herokuIntegration.getConnection(orgName);

                // Query DataCloud org
                logger.info(`Querying org ${org.id}: ${query}`);
                const response = await org.dataCloudApi.query(query);
                logger.info(`Query response: ${JSON.stringify(response.data || {})}`);
            }

            reply.code(201).send();
    });

    fastify.setErrorHandler(function (error, request, reply) {
        request.log.error(error)
        reply.status(500).send({ code: '500', message: error.message });
    });

     /**
     * Queries for and then returns all activies of the accountId in the invoking org.
     *
     * If an org reference is set on SALESFORCE_ORG_NAME config var,
     * obtain the org's connection from the Heroku Integration add-on
     * and query Accounts in the target org.
     *
     * @param request
     * @param reply
     * @returns {Promise<void>}
     */
    fastify.post('/activities', async function (request, reply) {
        const { event, context, logger } = request.sdk;
        const { accountId } = request.body;
    
        logger.info(`POST /activities: ${JSON.stringify(request.body)}`);
    
        if (!accountId) {
            return reply.status(400).send({ error: 'Missing required parameter: accountId' });
        }
    
        if (process.env.SALESFORCE_ORG_NAME) {
            const orgName = process.env.SALESFORCE_ORG_NAME;
            const herokuIntegration = request.sdk.addons.herokuIntegration;
    
            logger.info(`Getting ${orgName} org connection from Heroku Integration add-on...`);
            const anotherOrg = await herokuIntegration.getConnection(orgName);
    
            logger.info(`Querying all Activities for AccountId: ${accountId} for last 4 years...`);
            try {
                const query = `
                    SELECT Id, Subject,Description, ActivityDate, Status, Type
                    FROM Task
                    WHERE WhatId = '${accountId}' AND ActivityDate >= LAST_N_YEARS:4
                    ORDER BY ActivityDate DESC
                `;
    
                let activities = [];
                let queryResult = await anotherOrg.dataApi.query(query);
    
                // Collect initial records
                activities.push(...queryResult.records.map(rec => rec.fields));
    
                // Fetch more records if nextRecordsUrl exists
                while (queryResult.nextRecordsUrl) {
                    logger.info(`Fetching more records from ${queryResult.nextRecordsUrl}`);
                    queryResult = await anotherOrg.dataApi.queryMore(queryResult.nextRecordsUrl);
                    activities.push(...queryResult.records.map(rec => rec.fields));
                }
    
                logger.info(`Total activities fetched: ${activities.length}`);
                return reply.send({ activities });
    
            } catch (e) {
                logger.error(`Error querying activities: ${e.message}`);
                return reply.status(500).send({ error: e.message });
            }
        } else {
            
            const org = context.org;
            logger.info(`Querying all Activities for AccountId: ${accountId} for last 4 years...`);
            try {
                const query = `
                    SELECT Id, Subject,Description,ActivityDate, Status, Type
                    FROM Task
                    WHERE WhatId = '${accountId}' AND ActivityDate >= LAST_N_YEARS:4
                    ORDER BY ActivityDate DESC Limit 100
                `;
    
                /*let activities = [];
                let queryResult = await org.dataApi.query(query);

                logger.info(`queryResult: ${queryResult.nextRecordsUrl}`);
    
                // Collect initial records
                activities.push(...queryResult.records.map(rec => rec.fields));
    
                // Fetch more records if nextRecordsUrl exists
                while (queryResult.nextRecordsUrl) {

                    logger.info(`Fetching more records from ${queryResult.nextRecordsUrl}`);
                    queryResult = await org.dataApi.queryMore(queryResult.nextRecordsUrl);
                    activities.push(...queryResult.records.map(rec => rec.fields));

                    // Log the new number of records and nextRecordsUrl
                    logger.info(`Total records fetched: ${activities.length}`);
                    logger.info(`Next Records URL: ${queryResult.nextRecordsUrl}`);

                }*/

                const activities = await fetchRecords(context,logger,query);    
                
                logger.info(`Total activities fetched: ${activities.length}`);

                // Step 1: Generate JSON file
                const filePath = await generateFile(activities,logger);

                const openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY, // Read from .env
                  });

                // Step 2: Upload file to OpenAI
                const uploadResponse = await openai.files.create({
                    file: fs.createReadStream(filePath),
                    purpose: "assistants", // Required for storage
                });
            
                const fileId = uploadResponse.id;
                logger.info(`File uploaded to OpenAI: ${fileId}`);

                // Step 3: Create an Assistant (if not created before)
                const assistant = await openai.beta.assistants.create({
                    name: "Salesforce Summarizer",
                    instructions: "You are an AI that summarizes Salesforce activity data.",
                    tools: [{ type: "file_search" }], // Allows using files
                    model: "gpt-4-turbo",
                });

                logger.info(`Assistant created: ${assistant.id}`);

                // Step 4: Create a Thread
                const thread = await openai.beta.threads.create();
                logger.info(`Thread created: ${thread.id}`);

                // Step 5: Submit Message to Assistant (referencing file)
                const message = await openai.beta.threads.messages.create(thread.id, {
                    role: "user",
                    content: "Summarize the activities in this file into a structured JSON format categorized by quarterly, monthly, and weekly.",
                    attachments: [{ file_id: fileId }],
                });
            
                logger.info(`Message sent: ${message.id}`);

                // Step 6: Run the Assistant
                const run = await openai.beta.threads.runs.create(thread.id, {
                    assistant_id: assistant.id,
                });
            
                logger.info(`Run started: ${run.id}`);

                // Step 7: Wait for completion (polling for result)
                let status = "in_progress";
                let runResult;
                while (status === "in_progress" || status === "queued") {
                await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 sec
                runResult = await openai.beta.threads.runs.retrieve(thread.id, run.id);
                status = runResult.status;
                }

                if (status !== "completed") {
                throw new Error(`Run failed with status: ${status}`);
                }

                // Step 8: Retrieve response from messages
                const messages = await openai.beta.threads.messages.list(thread.id);
                const summary = messages.data[0].content[0].text.value;

                logger.info(`Summary received ${summary}`);
            
                // Send the summary as JSON response
                let tempactivities = [];
                tempactivities.push(summary);
                
                return tempactivities;
    
            } catch (e) {
                logger.error(`Error querying activities: ${e.message}`);
                return reply.status(500).send({ error: e.message });
            }
            //return reply.status(500).send({ error: 'Salesforce Org not configured' });
        }
    });

    // Fetch records from Salesforce
    async function generateFile( activities = [],logger) {
        const filePath = path.join(__dirname, "salesforce_activities.json");
        try {
            //const jsonlData = activities.map((entry) => JSON.stringify(entry)).join("\n");
            await fs.writeFile(filePath, JSON.stringify(activities, null, 2), "utf-8");
            //await fs.writeFile(filePath, jsonlData, "utf-8");
            logger.info(`File Generated successfully ${filePath}`);
            return filePath;
        } catch (error) {
            logger.info(`Error writing file: ${error}`);
            throw error;
        }
    }

    // Fetch records from Salesforce
    async function fetchRecords(context, logger, queryOrUrl, activities = [], isFirstIteration = true) {
        
        const org = context.org;
        try {
            const queryResult = isFirstIteration ? await org.dataApi.query(queryOrUrl) : await org.dataApi.queryMore(queryOrUrl);
            logger.info(`Fetched ${queryResult.records.length} records`);

            activities.push(...queryResult.records.map(rec => rec.fields));

            if (queryResult.nextRecordsUrl) {
                logger.info(`Fetching more records from ${queryResult.nextRecordsUrl}`);
                return fetchRecords(context, logger,queryResult, activities,false); // Recursive call
            } else {
                logger.info(`All records fetched: ${activities.length}`);
                return activities;
            }
        } catch (error) {
            logger.info(`Error fetching activities: ${error.message}`);
            throw error;
        }
    }
    
}
