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

    fastify.post('/activitysummarygeneration',
        // async=true to apply standard response 201 response or provide custom response handler function
        {config: {salesforce: {async: unitOfWorkResponseHandler}}},
        async (request, reply) => {
            const { event, context, logger } = request.sdk;
            const org = context.org;
            const dataApi = context.org.dataApi;

            logger.info(`POST /activitysummarygeneration ${JSON.stringify(event.data || {})}`);

            const validateField = (field, value) => {
                if (!value) throw new Error(`Please provide ${field}`);
            }

            // Validate Input
            const data = event.data;
            validateField('accountId', data.accountId);

            try 
            {
                const accountId=data.accountId;
                const query = `
                    SELECT Id, Subject,Description,ActivityDate, Status, Type
                    FROM Task
                    WHERE WhatId = '${accountId}' AND ActivityDate >= LAST_N_YEARS:4
                    ORDER BY ActivityDate DESC limit 5000
                    `;
                let groupedData={};    
                //fetch all activites of that account    
                const activities = await fetchRecords(context,logger,query,groupedData);    
                logger.info(`Total activities fetched: ${activities.length}`);

                // Step 1: Generate JSON file
                const filePath = await generateFile(activities,logger);

                const openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY, // Read from .env
                  });


                //deleteSalesforceActivitiesFile(logger,openai);

                // Step 2: Upload file to OpenAI
                const uploadResponse = await openai.files.create({
                    file: fs.createReadStream(filePath),
                    purpose: "assistants", // Required for storage
                });
            
                const fileId = uploadResponse.id;
                logger.info(`File uploaded to OpenAI: ${fileId}`);

                // Step 2.1: Wait for the file to be processed
                await waitForFileProcessing(logger,fileId,openai);

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
                    content: `You are an AI that summarizes Salesforce activity data into a structured format. Your task is to analyze the uploaded file, which contains sales rep conversations with prospects, and generate a structured JSON summary categorized by:

                    - **Quarterly**
                    - **Monthly**
                    - **Weekly**

                    If there are insufficient records for any category, **still generate that section** and mention "Insufficient data" instead of omitting it.

                    Ensure that:
                    - Each section includes key themes discussed.
                    - Summarize the main takeaways from interactions.
                    - Highlight action points, objections, and outcomes.
                    - Group activities based on the 'activityDate' field.

                    The final response **MUST** be a single-line, minified JSON object without unnecessary whitespace, newline characters, or special formatting. It should strictly follow this structure:

                    {"quarterly_summary":[{"quarter":"Q1 2024","summary":"...","key_topics":["..."],"action_items":["..."]},{"quarter":"Q2 2024","summary":"...","key_topics":["..."],"action_items":["..."]}],"monthly_summary":[{"month":"January 2024","summary":"...","key_topics":["..."],"action_items":["..."]},{"month":"February 2024","summary":"...","key_topics":["..."],"action_items":["..."]}],"weekly_summary":[{"week":"2024-W01","summary":"...","key_topics":["..."],"action_items":["..."]}]}
                    **Strict Requirements:**
                    1. **Return only the JSON object** with no explanations or additional text.
                    2. **Ensure JSON is in minified format** (i.e., no extra spaces, line breaks, or special characters).
                    3. The response **must be directly usable with "JSON.parse(response)"**.
                    
                    **Handling Large Data Volumes:**  
                    If the data volume is too large for processing and summarization is not possible, return:  
                    {"error":"Can't summarize due to large amount of data"}`,
                    attachments: [
                        { 
                            file_id: fileId,
                            tools: [{ type: "file_search" }],
                        }
                    ],
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
                await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 2 sec
                runResult = await openai.beta.threads.runs.retrieve(thread.id, run.id);
                status = runResult.status;
                }

                if (status !== "completed") 
                {
                    logger.info(`Run failed: ${JSON.stringify(runResult, null, 2)}`);
                    throw new Error(`Run failed with status: ${status}`);
                }

                // Step 8: Retrieve response from messages
                const messages = await openai.beta.threads.messages.list(thread.id);

                //logger.info(`messages received ${JSON.stringify(messages)}`);

                const summary = messages.data[0].content[0].text.value;
                logger.info(`Summary received ${JSON.stringify(messages.data[0].content[0])}`);
                logger.info(`Summary received ${JSON.stringify(messages.data[0].content[0].text)}`);
                logger.info(`Summary received ${summary}`);

                // Construct the result by getting the Id from the successful inserts
                const callbackResponseBody = {
                    summaryDetails: summary
                };

                const opts = {
                    method: 'POST',
                    body: JSON.stringify(callbackResponseBody),
                    headers: {'Content-Type': 'application/json'}
                }
                const callbackResponse = await org.request(data.callbackUrl, opts);
                logger.info(JSON.stringify(callbackResponse));
                
            }
            catch (err) 
            {
                const errorMessage = `Failed to process summary. Root Cause : ${err.message}`;
                logger.error(errorMessage);
                throw new Error(errorMessage);
            }

            return reply;
    });


    fastify.post('/asynchactivitysummarygeneration',
        // async=true to apply standard response 201 response or provide custom response handler function
        {config: {salesforce: {async: unitOfWorkResponseHandler}}},
        async (request, reply) => {
            const { event, context, logger } = request.sdk;
            const org = context.org;
            const dataApi = context.org.dataApi;

            logger.info(`POST /asynchactivitysummarygeneration ${JSON.stringify(event.data || {})}`);

            const validateField = (field, value) => {
                if (!value) throw new Error(`Please provide ${field}`);
            }

            // Validate Input
            const data = event.data;
            validateField('accountId', data.accountId);//queryText,assisstantPrompt,userPrompt
            validateField('queryText', data.queryText);
            validateField('assisstantPrompt', data.assisstantPrompt);
            validateField('userPrompt', data.userPrompt);

            try 
            {
                const accountId=data.accountId;
                const queryText=data.queryText;
                const assisstantPrompt=data.assisstantPrompt;
                const userPrompt=data.userPrompt;
                const query = queryText;
                
                //fetch all activites of that account 
                let groupedData={};    
                groupedData = await fetchRecords(context,logger,query,groupedData);    
                //logger.info(`Total activities fetched: ${JSON.stringify(groupedData)}`);

                
                // Step 1: Group Activites by Yearly & its Monthly
                //const groupedData = await groupActivities(activities,logger);

                //logger.info(`groupedData activities fetched: ${JSON.stringify(groupedData)}`);

                const openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY, // Read from .env
                  });
                
                // Step 3: Create an Assistant (if not created before)
                const assistant = await openai.beta.assistants.create({
                    name: "Salesforce Summarizer",
                    instructions: "You are an AI that summarizes Salesforce activity data.",
                    tools: [{ type: "file_search" }], // Allows using files
                    model: "gpt-4-turbo",
                });

                logger.info(`Assistant created: ${assistant.id}`);

                  const finalSummary = {};

                    /*for (const year in groupedData) 
                    {
                        finalSummary[year] = {};
                        for (const quarter in groupedData[year]) {
                            finalSummary[year][quarter] = {};
                            for (const month in groupedData[year][quarter]) {
                                console.log(`Processing: Year ${year}, ${quarter}, Month ${month}`);
                
                                // Send each month's data separately
                                const summary = await generateSummary(groupedData[year][quarter][month],openai,logger);
                
                                // Store summarized response
                                finalSummary[year][quarter][month] = summary || 'Error generating summary';
                            }
                        }
                    }*/
                        for (const year in groupedData) {
                            logger.info(`Year: ${year}`);
                            finalSummary[year] = {};
                            // Iterate through the months inside each year
                            for (const monthObj of groupedData[year]) {
                                for (const month in monthObj) {
                                    logger.info(`  Month: ${month}`);
                                    const tmpactivites = monthObj[month];
                                    logger.info(`  ${month}: ${tmpactivites.length} activities`);
                                    const summary = await generateSummary(tmpactivites,openai,logger,assistant,userPrompt);
                                    finalSummary[year][month] = summary;
                                }
                            }
                        }
                    /*for (const year in groupedData) {
                        logger.info(`Year: ${year}`);
                        finalSummary[year] = {};
                        for (const month in groupedData[year]) {
                            const tmepActivities = groupedData[year][month];
                            logger.info(`  ${month}: ${tmepActivities.length} activities`);
                            const summary = await generateSummary(tmepActivities,openai,logger,assistant);
                            finalSummary[year][month] = summary;
                
                        }
                    }*/

                logger.info(`Final Summary received ${JSON.stringify(finalSummary)}`);
                

                const createmonthlysummariesinsalesforce = await createTimileSummarySalesforceRecords( finalSummary,accountId,'Monthly',dataApi,logger);

                const Quarterlysummary = await generateSummary(finalSummary,openai,logger,assistant,
                    `I have a JSON file containing monthly summaries of an account, where data is structured by year and then by month. Please generate a quarterly summary for each year while considering that the fiscal quarter starts in January. The output should be in JSON format, maintaining the same structure but grouped by quarters instead of months. Ensure the summary for each quarter appropriately consolidates the insights from the respective months.
                    **Strict Requirements:**
                    1. **Summarize all three months into a single quarterly summary. Do not retain individual months as separate keys. The summary should combine key themes, tone, response trends, and follow-up actions from all months within the quarter.
                    2. **Return only the JSON object** with no explanations or additional text.
                    3. JSON Structure should be: {"year": {"Q1": "quarterly summary", "Q2": "quarterly summary", ...}}
                    4. **Ensure JSON is in minified format** (i.e., no extra spaces, line breaks, or special characters).
                    5. The response **must be directly usable with "JSON.parse(response)"**.`);
                                  
                logger.info(`Quarterlysummary received ${JSON.stringify(Quarterlysummary)}`);

                const quaertersums=JSON.parse(Quarterlysummary);
                logger.info(`Quarterlysummary received ${JSON.stringify(quaertersums)}`);

                for (const year in quaertersums) {
                    logger.info(`Year: ${year}`);
                    for (const month in quaertersums[year]) {
                        logger.info(`Month: ${month}`);
                    }
                }

                //const createQuarterlysummariesinsalesforce = await createTimileSummarySalesforceRecords( JSON.parse(Quarterlysummary),accountId,'Quarterly',dataApi,logger);

                
                /*const uploadResponse = await openai.files.create({
                    file: fs.createReadStream(filePath),
                    purpose: "assistants", // Required for storage
                });
                    
                const fileId = uploadResponse.id;
                logger.info(`File uploaded to OpenAI: ${fileId}`);

                

                const finalSummary=await generateSummaryFromVectorStore(fileId,openai,logger,assisstantPrompt,userPrompt);*/
                
                // Construct the result by getting the Id from the successful inserts
                const callbackResponseBody = {
                    summaryDetails: `{"success":"All Quarterly and Monthly based sumaries were created / updated of this account"}`
                };

                const opts = {
                    method: 'POST',
                    body: JSON.stringify(callbackResponseBody),
                    headers: {'Content-Type': 'application/json'}
                }
                
                const callbackResponse = await org.request(data.callbackUrl, opts);
                logger.info(JSON.stringify(callbackResponse));
                
            }
            catch (err) 
            {
                const errorMessage = `Failed to process summary. Root Cause : ${err.message}`;
                logger.error(errorMessage);
                throw new Error(errorMessage);
            }

            return reply;
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
                    ORDER BY ActivityDate DESC limit 10
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
                let groupedData={};    
                const activities = await fetchRecords(context,logger,query,groupedData);    
                
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
                    content: `You are an AI that summarizes Salesforce activity data into a structured format. Your task is to analyze the uploaded file, which contains sales rep conversations with prospects, and generate a structured JSON summary categorized by:

                    - **Quarterly**
                    - **Monthly**
                    - **Weekly**

                    If there are insufficient records for any category, **still generate that section** and mention "Insufficient data" instead of omitting it.

                    Ensure that:
                    - Each section includes key themes discussed.
                    - Summarize the main takeaways from interactions.
                    - Highlight action points, objections, and outcomes.
                    - Group activities based on the 'activityDate' field.

                    The final response **MUST** be a single-line, minified JSON object without unnecessary whitespace, newline characters, or special formatting. It should strictly follow this structure:

                    {"quarterly_summary":[{"quarter":"Q1 2024","summary":"...","key_topics":["..."],"action_items":["..."]},{"quarter":"Q2 2024","summary":"...","key_topics":["..."],"action_items":["..."]}],"monthly_summary":[{"month":"January 2024","summary":"...","key_topics":["..."],"action_items":["..."]},{"month":"February 2024","summary":"...","key_topics":["..."],"action_items":["..."]}],"weekly_summary":[{"week":"2024-W01","summary":"...","key_topics":["..."],"action_items":["..."]}]}
                    **Strict Requirements:**
                    1. **Return only the JSON object** with no explanations or additional text.
                    2. **Ensure JSON is in minified format** (i.e., no extra spaces, line breaks, or special characters).
                    3. The response **must be directly usable with "JSON.parse(response)"**.`,
                    attachments: [
                        { 
                            file_id: fileId,
                            tools: [{ type: "file_search" }],
                        }
                    ],
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

                //logger.info(`messages received ${JSON.stringify(messages)}`);

                const summary = messages.data[0].content[0].text.value;
                logger.info(`Summary received ${JSON.stringify(messages.data[0].content[0])}`);
                logger.info(`Summary received ${JSON.stringify(messages.data[0].content[0].text)}`);
                logger.info(`Summary received ${summary}`);
            
                // Send the summary as JSON response
                let tempactivities = [];
                let activity={};
                activity.subject=summary;
                tempactivities.push(activity);
                
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

        // Get current date-time in YYYYMMDD_HHMMSS format
        const timestamp = new Date().toISOString().replace(/[:.-]/g, "_");
        const filename = `salesforce_activities_${timestamp}.json`;

        const filePath = path.join(__dirname, filename);
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

    //create assistant and generate summary
    async function generateSummaryFromVectorStore(fileId, openai,logger,assisstantPrompt,userPrompt) 
    {
        //Step 1: Create Salesforce Data Analyst Assistant
        const myAssistant = await openai.beta.assistants.create({
            instructions:
              "You are an Salesforce Data Analyst, and you have access to files that activities of an account to summarize those activites for Quarterly and monthly basis of each year and provide that output in a JSON format",
            name: "Salesforce Data Analyst",
            tools: [{ type: "file_search" }],
            model: "gpt-4o"
          });

          logger.info(`Assistant Id is:${myAssistant.id}`);

          //step 2: Create Vector Store
          const vectorStore = await openai.beta.vectorStores.create({
            name: "Salesforce_Account_Activites",
            expires_after: {
                anchor: "last_active_at",
                days: 1
            }
          });

          logger.info(`vector Store Id is:${vectorStore.id}`);

          logger.info(`filepath is:${fileId}`);

          //step 3: Add created file into vectorstore as filestream
          const myVectorStoreFile = await openai.beta.vectorStores.files.create(
            vectorStore.id,
            {
              file_id: fileId
            }
          );
          logger.info(`myVectorStoreFile is: ${myVectorStoreFile}`);

          //step 4: upload files to vectorstores
          //const fileBatch=await openai.beta.vectorStores.fileBatches.createAndPoll(vectorStore.id, fileStreams);
          //logger.info(`fileBatch Status is:${fileBatch.status}`);

          //step 5: update assistant with vector store
          const assistant=await openai.beta.assistants.update(myAssistant.id, {
            tool_resources: { file_search: { vector_store_ids: [vectorStore.id] } },
          });

          //step 6: create a thread & message
          const thread = await openai.beta.threads.create({
            messages: [
              {
                role: "assistant",
                content:assisstantPrompt,
              }, 
              {
                role: "user",
                content:userPrompt,
                // Attach the new file to the message.
                attachments: [{ 
                        file_id: fileId,
                        tools: [{ type: "file_search" }],
                    }],
              },
            ],
          });

          logger.info(thread.tool_resources?.file_search);

          //step 7: run threads and get the output
          const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
            assistant_id: assistant.id,
          });
          
          const messages = await openai.beta.threads.messages.list(thread.id, {
            run_id: run.id,
          });

          const summary = messages.data[0].content[0].text.value;
          logger.info(`Summary received ${JSON.stringify(messages.data[0].content[0])}`);
          
          const message = messages.data[0];
          let txtoutput;
          if (message.content[0].type === "text") {
            const { text } = message.content[0];
            const { annotations } = text;
            const citations = [];
          
            let index = 0;
            for (let annotation of annotations) {
              text.value = text.value.replace(annotation.text, "[" + index + "]");
              const { file_citation } = annotation;
              if (file_citation) {
                const citedFile = await openai.files.retrieve(file_citation.file_id);
                citations.push("[" + index + "]" + citedFile.filename);
              }
              index++;
            }
            txtoutput=text.value;
            logger.info(text.value);
            logger.info(citations.join("\n"));
            }

            const deletedVectorStore = await openai.beta.vectorStores.del(
                vectorStore.id
              );
            
              logger.info(`deletedVectorStore is: ${deletedVectorStore}`);

            return txtoutput;
    }

    // Process Each Chunk with OpenAI API
    async function generateSummary(activities, openai,logger,assistant,userPrompt) 
    {
        
            if (Array.isArray(activities)) 
            {
                logger.info("Array / List of objects");
                if (!activities || activities.length === 0) return null; // Skip empty chunks
                logger.info(`Total activities fetched: ${activities.length}`);
            } 
            else if (typeof activities === "object" && activities !== null) 
            {
                logger.info("JSON/Object");
            }
 
        // Step 1: Generate JSON file
        const filePath = await generateFile(activities,logger);

        // Step 2: Upload file to OpenAI
        const uploadResponse = await openai.files.create({
            file: fs.createReadStream(filePath),
            purpose: "assistants", // Required for storage
        });
            
        const fileId = uploadResponse.id;
        logger.info(`File uploaded to OpenAI: ${fileId}`);

        // Step 4: Create a Thread
        const thread = await openai.beta.threads.create();
        logger.info(`Thread created: ${thread.id}`);

        // Step 5: Submit Message to Assistant (referencing file)
        const message = await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content:userPrompt,
                    attachments: [
                        { 
                            file_id: fileId,
                            tools: [{ type: "file_search" }],
                        }
                    ],
                });
            
        logger.info(`Message sent: ${message.id}`);

        // Step 6: Run the Assistant
        const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
            assistant_id: assistant.id,
        });
            
        logger.info(`Run started: ${run.id}`);

        const messages = await openai.beta.threads.messages.list(thread.id, {
            run_id: run.id,
          });

          // Log the full response structure
         logger.info(`OpenAI msg content Response: ${JSON.stringify(messages, null, 2)}`);

          const summary = messages.data[0].content[0].text.value;
          logger.info(`Summary received ${JSON.stringify(messages.data[0].content[0])}`);
        
          logger.info(`Summary received ${summary}`);

          const file = await openai.files.del(fileId);

          logger.info(file);

        return summary.replace(/(\[\[\d+†source\]\]|\【\d+:\d+†source\】)/g, '');

    }
    async function createTimileSummarySalesforceRecords( summaries={},parentId,summaryCategory,dataApi,logger) {

        // Create a unit of work that inserts multiple objects.
        const uow = dataApi.newUnitOfWork();
            
        for (const year in summaries) {
            logger.info(`Year: ${year}`);
            for (const month in summaries[year]) {
                logger.info(`Month: ${month}`);
                logger.info(`Summary:\n${summaries[year][month]}\n`);
                let FYQuartervalue=(summaryCategory=='Quarterly')?month:'';
                let motnhValue=(summaryCategory=='Monthly')?month:'';
                let summaryValue=summaries[year][month];
                 uow.registerCreate({
                    type: 'Timeline_Summary__c',
                    fields: {
                        Parent_Id__c : parentId,
                        Month__c : motnhValue,
                        Year__c : year,
                        Summary_Category__c : summaryCategory,
                        Summary_Details__c : summaryValue,
                        FY_Quarter__c : FYQuartervalue
                    }
                });
            }
        }
        try {
            // Commit the Unit of Work with all the previous registered operations
            const response = await dataApi.commitUnitOfWork(uow);
        }
        catch (err) {
            const errorMessage = `Failed to insert record. Root Cause : ${err.message}`;
            logger.error(errorMessage);
            throw new Error(errorMessage);
        }
    }
    // group activities by Quarterly,Monthly,Weekly for each year
    async function groupActivities( activities = [],logger) {

        const groupedData = {};

        /*activities.forEach(activity => {
            const date = new Date(activity.activitydate); // Assuming activity has a timestamp
            const year = date.getFullYear();
            const month = date.getMonth() + 1; // JavaScript months are 0-indexed
            const quarter = Math.ceil(month / 3);

            if (!groupedData[year]) groupedData[year] = {};
            if (!groupedData[year][`Q${quarter}`]) groupedData[year][`Q${quarter}`] = {};
            if (!groupedData[year][`Q${quarter}`][month]) groupedData[year][`Q${quarter}`][month] = [];

            groupedData[year][`Q${quarter}`][month].push(activity);
        });*/

        activities.forEach(activity => {
            const date = new Date(activity.activitydate); // Assuming 'date' is in a valid format
            const year = date.getFullYear();
            const month = date.toLocaleString('en-US', { month: 'long' });
    
            const key = `${month}`;
    
            if (!groupedData[year]) {
                groupedData[year] = [];
            }
    
            // Find the existing month entry or create a new one
            let monthEntry = groupedData[year].find(entry => entry[key]);
            if (!monthEntry) {
                monthEntry = { [key]: [] };
                groupedData[year].push(monthEntry);
            }
    
            monthEntry[key].push(activity);
        });

        logger.info(`grouped data is ${JSON.stringify(groupedData)}`);

        return groupedData;
    }

    // delect salesforce activites files generated for openAI Processing
    async function waitForFileProcessing(logger,fileId,openai) {

        let isProcessing = true;

        while (isProcessing) {
            try 
            {
                const fileDetails = await openai.files.retrieve(fileId);
                logger.info(`Checking file ${fileId}: Status - ${fileDetails.status}`);

                if (fileDetails.status === "processed") {
                    logger.info(`File ${fileId} is processed.`);
                    isProcessing = false;
                } else {
                    logger.info(`File still processing... Retrying in 5 seconds.`);
                    await new Promise((resolve) => setTimeout(resolve, 300000)); // Wait 10 sec
                }
            } 
            catch (error) 
            {
                logger.info("Error checking file status:", error);
                throw error;
            }
        }
    }

    // Fetch records from Salesforce
    async function fetchRecords(context, logger, queryOrUrl, groupedData, isFirstIteration = true) {
        
        const org = context.org;
        try {
            const queryResult = isFirstIteration ? await org.dataApi.query(queryOrUrl) : await org.dataApi.queryMore(queryOrUrl);
            //logger.info(`Fetched ${queryResult.records.length} records`);

            //activities.push(...queryResult.records.map(rec => rec.fields));

            queryResult.records.forEach(activity => {
                const date = new Date(activity.fields.activitydate); // Assuming 'date' is in a valid format
                const year = date.getFullYear();
                const month = date.toLocaleString('en-US', { month: 'long' });
        
                const key = `${month}`;
        
                if (!groupedData[year]) {
                    groupedData[year] = [];
                }
        
                // Find the existing month entry or create a new one
                let monthEntry = groupedData[year].find(entry => entry[key]);
                if (!monthEntry) {
                    monthEntry = { [key]: [] };
                    groupedData[year].push(monthEntry);
                }
        
                monthEntry[key].push(activity.fields.description);
            });
            //logger.info(`groupedData: ${JSON.stringify(groupedData)}`);
            if (queryResult.nextRecordsUrl) {
                //logger.info(`Fetching more records from ${queryResult.nextRecordsUrl}`);
                return fetchRecords(context, logger,queryResult, groupedData,false); // Recursive call
            } else {
                //logger.info(`All records fetched: ${JSON.stringify(groupedData)}`);
                return groupedData;
            }
        } catch (error) {
            logger.info(`Error fetching activities: ${error.message}`);
            throw error;
        }
    }
    
}
