'use strict'

require('text-encoder')
const express = require('express')
const https = require('https')
const bodyParser = require('body-parser')
const HTTPStatus = require('http-status-codes')
const path = require('path')
const fs = require('fs')
const NATS = require('nats')
const FabricCAServices = require('fabric-ca-client')
const { Gateway, Wallets } = require('fabric-network')
const app = express()
var cfg, profile
var contract, wallet

app.use(bodyParser.json())

// cert and key for HTTPS
const options = {
    key: fs.readFileSync(path.resolve(__dirname, 'conf/certs/lfh-fabric-client.key')),
    cert: fs.readFileSync(path.resolve(__dirname, 'conf/certs/lfh-fabric-client.pem'))
};

setup().then(() => {
    var server = https.createServer(options, app)
    server.listen(cfg.port, () => {
        console.log("Server listening on port : " + cfg.port)
    })
})

// GET the record identified by the id in the request query
app.get('/patient', (req, res) => {
    req.body = { "fcn": "queryPatient", "args": [ req.query.id ] }
    sendTransactionHTTP(req, res)
})

// POST the record using the JSON in the request body
app.post('/patient', (req, res) => {
    req.body = { "fcn": "addPatient", "args": [ req.body.id, req.body] }
    sendTransactionHTTP(req, res)
})

// PUT the record using the JSON in the request body
app.put('/patient', (req, res) => {
    req.body = { "fcn": "replacePatient", "args": [ req.body.id, req.body] }
    sendTransactionHTTP(req, res)
})

// PATCH the record using the JSON in the request body
app.patch('/patient', (req, res) => {
    req.body = { "fcn": "updatePatient", "args": [ req.body.id, req.body] }
    sendTransactionHTTP(req, res)
})

/**
  * Send the transaction. Since all API calls are invokes, the steps are the
  * same for get, post, put, patch.
  */
async function sendTransactionHTTP (req, res) {
    const { fcn } = req.body
    let { args } = req.body

    try {
        // Allow JSON objects in REST body by stringifying here
        args = stringifyArrayValues(args)

        // Create the transaction
        const transaction = contract.createTransaction(fcn)

        // Submit the transaction
        transaction.submit(...args)
        .then(respbytes => {
            let response = ''
            if (respbytes && respbytes.length > 0) response = JSON.parse(respbytes.toString())
            res.status(HTTPStatus.OK).send(response)
            console.log(`Submitted ${fcn} transaction`)
        })
        .catch(error => {
            // If we couldn't submit, assume it's a problem with the request => 400
            // We could differentiate the errors, as 502 Bad Gateway is also a possibility.
            console.log(error)
            res.status(HTTPStatus.BAD_REQUEST).send(JSON.stringify(error.message))
        })
    } catch (error) {
        // Any other problem => 500
        res.status(HTTPStatus.INTERNAL_SERVER_ERROR).send(JSON.stringify(error.message))
    }
}

/**
  * Send the transaction. Since all API calls are invokes, the steps are the
  * same for get, post, put, patch.
  */
async function sendTransaction (fcn, args) {
    // Allow JSON objects in REST body by stringifying here
    args = stringifyArrayValues(args)

    // Create the transaction
    const transaction = contract.createTransaction(fcn)

    // Submit the transaction
    transaction.submit(...args)
    .then(respbytes => {
        let response = ''
        if (respbytes && respbytes.length > 0) response = JSON.parse(respbytes.toString())
    })
}

/**
  * Read the configuration file and create the connection to the blockchain.
  */
async function setup () {
    try {
        // Get config parameters
        cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'conf/config.json')))
        console.log('Read the JSON config file')

        // Get the connection profile
        profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, cfg.connection_profile)))

        // Create a new file system wallet for managing identities
        const walletPath = path.resolve(__dirname, cfg.wallet_location)
        wallet = await Wallets.newFileSystemWallet(walletPath)
        console.log(`Wallet path: ${walletPath}`)

        // Enroll an admin, if configured (recommended for dev/test only)
        if (cfg.enroll_admin === 'true') {
            console.log(`Enrolling admin user: ${cfg.admin_name}`)
            await enrollAdmin()
        }

        // Register a user, if configured (recommended for dev/test only)
        if (cfg.register_user === 'true') {
            console.log(`Registering user: ${cfg.user_name}`)
            await registerUser()
        }

        // Add NATS subscribers, if configured
        if (cfg.use_nats === 'true') {
            console.log(`Configuring NATS subscribers`)
            await subscribe()
        }

        // Make sure we have a registered user
        const identity = await wallet.get(cfg.user_name)
        if (!identity) {
            console.log(`An identity for the user ${cfg.user_name} does not exist in the wallet`)
            process.exit(1)
        }

        // Create a new gateway for connecting to our peer node
        const use_disc = process.env.INITIALIZE_WITH_DISCOVERY || cfg.use_discovery
        const as_local = process.env.DISCOVERY_AS_LOCALHOST || cfg.as_local_host
        const enabled = true ? use_disc === 'true' : false
        const asLocalhost = true ? as_local === 'true' : false
        console.log(`Discovery enabled = ${enabled} asLocalhost = ${asLocalhost}`)
        const gateway = new Gateway()
        await gateway.connect(profile, { wallet, identity: cfg.user_name, discovery: { enabled, asLocalhost } })

        // Get the network (channel) our contract is deployed to
        const network = await gateway.getNetwork(cfg.channel)

        // Get the contract from the network
        contract = network.getContract(cfg.contract)
        console.log('Connected to the blockchain')
    } catch (error) {
        console.error(`Failed to set up the fabric client: ${error}`)
        process.exit(1)
    }
}

/**
  * Subscribe to LinuxForHealth EVENTS.sync messages.
  */
async function subscribe () {
    var server
    const nkey = fs.readFileSync(path.resolve(__dirname, cfg.nats_nkey))

    for (server in cfg.nats_servers) {
        console.log('servers=tls://'+cfg.nats_servers[server])
        let nc = await NATS.connect({
            servers: 'tls://'+cfg.nats_servers[server],
            authenticator: NATS.nkeyAuthenticator(new TextEncoder().encode(nkey)),
            tls: {
                caFile: cfg.nats_ca_file,
            }
        })

        let sub = nc.subscribe('EVENTS.sync')
        handleMessages(sub)
        console.log('Subscribed to EVENTS.sync messages from tls://'+cfg.nats_servers[server])
    }
}

/**
  * Process EVENTS.sync messages for a single NATS subscription.
  */
async function handleMessages (sub) {
    for await (const msg of sub) {
        var fcn
        let lfh_msg = JSON.parse(new TextDecoder().decode(msg.data))
        let lfh_data_str = Buffer.from(lfh_msg.data, 'base64').toString('utf-8')
        let { uuid, operation, data_format } = lfh_msg
        if (data_format === 'FHIR-R4_PATIENT') {
            switch (operation) {
                default:
                case 'POST':
                    fcn = 'addPatient'
                    break;
                case 'PUT':
                    fcn = 'replacePatient'
                    break;
                case 'PATCH':
                    fcn = 'updatePatient'
                    break;
                case 'GET':
                    fcn = 'queryPatient'
                    break;
            }
        } else {
            console.log(`Unsupported data format ${data_format}`)
        }
        if (fcn) {
            try {
                await sendTransaction(fcn,  [ uuid, lfh_data_str ])
            } catch (error) {
                console.log(`Error submitting ${fcn} transaction: ${error}`)
            }
        }
    }
}

/**
  * Enroll an admin.
  *
  * Based on the Hyperledger Fabric fabcar enrollAdmin.js example in hyperledger/fabric-samples.
  */
async function enrollAdmin() {
    try {
        // Create a new CA client for interacting with the CA.
        const caInfo = profile.certificateAuthorities[cfg.certificate_authority]
        const caTLSCACerts = caInfo.tlsCACerts.pem
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName)

        // Check to see if we've already enrolled the admin user.
        const identity = await wallet.get(cfg.admin_name)
        if (identity) {
            console.log(`An identity for the admin user ${cfg.admin_name} already exists in the wallet - no admin enrollment needed`)
            return
        }

        // Enroll the admin user, and import the new identity into the wallet.
        const enrollment = await ca.enroll({ enrollmentID: cfg.admin_name, enrollmentSecret: cfg.admin_pw })
        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: cfg.msp_id,
            type: 'X.509',
        };
        await wallet.put(cfg.admin_name, x509Identity)
        console.log(`Successfully enrolled admin user ${cfg.admin_name} and imported it into the wallet`)
    } catch (error) {
        console.error(`Failed to enroll admin user ${cfg.admin_name}: ${error}`)
        process.exit(1)
    }
}

/**
  * Register a user.
  *
  * Based on the Hyperledger Fabric fabcar registerUser.js example in hyperledger/fabric-samples.
  */
async function registerUser() {
    try {
        // Create a new CA client for interacting with the CA.
        const caURL = profile.certificateAuthorities[cfg.certificate_authority].url
        const ca = new FabricCAServices(caURL)

        // Check to see if we've already enrolled the user.
        const userIdentity = await wallet.get(cfg.user_name)
        if (userIdentity) {
            console.log(`An identity for the user ${cfg.user_name} already exists in the wallet - no user registration needed`)
            return
        }

        // Check to see if we've already enrolled the admin user
        const adminIdentity = await wallet.get(cfg.admin_name)
        if (!adminIdentity) {
            console.log(`An identity for the admin user ${cfg.admin_name} does not exist in the wallet`)
            process.exit(1)
        }

        // Build a user object for authenticating with the CA
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type)
        const adminUser = await provider.getUserContext(adminIdentity, cfg.admin_name)

        // Register the user, enroll the user, and import the new identity into the wallet
        const secret = await ca.register({
            affiliation: 'org1.department1',
            enrollmentID: cfg.user_name,
            role: 'client'
        }, adminUser)
        const enrollment = await ca.enroll({
            enrollmentID: cfg.user_name,
            enrollmentSecret: secret
        })
        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: cfg.msp_id,
            type: 'X.509',
        }
        await wallet.put(cfg.user_name, x509Identity)
        console.log(`Successfully registered and enrolled user ${cfg.user_name} and imported it into the wallet`)
    } catch (error) {
        console.error(`Failed to register user ${cfg.user_name}: ${error}`)
        process.exit(1)
    }
}

/**
  * args needs to be an array of strings, but it is easier to work with JSON.
  * Allow JSON payloads by stringifying each element of the args array, if necessary.
  */
function stringifyArrayValues (args) {
    let newArray = []
    args.forEach(item => {
        typeof item === 'string' ? newArray.push(item) : newArray.push(JSON.stringify(item))
    })
    return newArray
}
