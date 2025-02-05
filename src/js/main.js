/*
 * Copyright (c) 2013-2017 CoNWeT Lab., Universidad Politécnica de Madrid
 * Copyright (c) 2019-2021 Future Internet Consulting and Development Solutions S.L.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* globals MashupPlatform, moment, NGSI */

(function () {

    "use strict";

    /* *****************************************************************************/
    /* ******************************** PRIVATE ************************************/
    /* *****************************************************************************/

    const doInitialQueries = function doInitialQueries(idPattern, types, filter, attributes, metadata) {
        this.query_task = requestInitialData.call(this, idPattern, types, filter, attributes, metadata, 0);
    };

    const refreshNGSISubscription = function refreshNGSISubscription() {
        if (this.subscriptionId) {
            this.connection.ld.updateSubscription({
                id: this.subscriptionId,
                expires: moment().add('3', 'hours').toISOString()
            }).then(
                () => {
                    MashupPlatform.operator.log("Subscription refreshed sucessfully", MashupPlatform.log.INFO);
                },
                () => {
                    MashupPlatform.operator.log("Error refreshing current context broker subscription");
                }
            );
        }
    };

    const handlerReceiveEntities = function handlerReceiveEntities(format, elements) {
        if (MashupPlatform.operator.outputs.entityOutput.connected) {
            MashupPlatform.wiring.pushEvent("entityOutput", elements);
        } else if (MashupPlatform.operator.outputs.entityOutput.connected) {
            MashupPlatform.wiring.pushEvent("entityOutput", elements.map(normalize2KeyValue));
        }
        if (MashupPlatform.operator.outputs.normalizedOutput && format === "normalized") {
            MashupPlatform.wiring.pushEvent("normalizedOutput", elements);
        }
    };

    const doInitialSubscription = function doInitialSubscription() {

        this.subscriptionId = null;
        this.connection = null;

        if (!MashupPlatform.operator.outputs.entityOutput.connected && !MashupPlatform.operator.outputs.normalizedOutput.connected) {
            return;
        }

        this.ngsi_server = MashupPlatform.prefs.get('ngsi_server');
        this.ngsi_proxy = MashupPlatform.prefs.get('ngsi_proxy');

        const request_headers = {};

        if (MashupPlatform.prefs.get('use_owner_credentials')) {
            request_headers['FIWARE-OAuth-Token'] = 'true';
            request_headers['FIWARE-OAuth-Header-Name'] = 'X-Auth-Token';
            request_headers['FIWARE-OAuth-Source'] = 'workspaceowner';
        }

        const tenant = MashupPlatform.prefs.get('ngsi_tenant').trim();
        if (tenant !== '') {
            request_headers['FIWARE-Service'] = tenant;
        }

        const path = MashupPlatform.prefs.get('ngsi_service_path').trim();
        if (path !== '' && path !== '/') {
            request_headers['FIWARE-ServicePath'] = path;
        }

        this.connection = new NGSI.Connection(this.ngsi_server, {
            use_user_fiware_token: MashupPlatform.prefs.get('use_user_fiware_token'),
            request_headers: request_headers, // Passar aqui o Auth Token
            ngsi_proxy_url: this.ngsi_proxy
        });

        let types = MashupPlatform.prefs.get('ngsi_entities').trim().replace(/,+\s+/g, ',');
        if (types === '') {
            types = undefined;
        }

        let id_pattern = MashupPlatform.prefs.get('ngsi_id_filter').trim();
        if (id_pattern === '') {
            id_pattern = '.*';
        }

        // Filter using the Simple Query Language supported by NGSIv2
        let filter = MashupPlatform.prefs.get('query').trim();
        if (filter === "") {
            filter = undefined;
        }

        // Filter entity attributes
        let attributes = MashupPlatform.prefs.get("ngsi_attributes").trim();
        if (attributes === "" || attributes === "*") {
            attributes = undefined;
        }

        // Filter attribute metadata
        let metadata = MashupPlatform.prefs.get("ngsi_metadata").trim();
        if (metadata === "" || metadata === "*") {
            metadata = undefined;
        }

        // Monitored attributes
        let monitored_attrs = MashupPlatform.prefs.get('ngsi_update_attributes').trim();
        let condition = undefined;
        if (filter != null || monitored_attrs !== "") {
            condition = {};
        }
        if (monitored_attrs !== "") {
            monitored_attrs = monitored_attrs.split(/,\s*/);
            condition.attrs = monitored_attrs.includes("*") ? [] : monitored_attrs;
        }
        if (filter != null) {
            condition.expression = {
                q: filter
            };
        }

        if (monitored_attrs === "") {
            doInitialQueries.call(this, id_pattern, types, filter, attributes, metadata);
        } else {
            let entities = [];
            if (types != null) {
                entities = types.split(',').map((type) => {
                    return {
                        idPattern: id_pattern,
                        type: type
                    };
                });
            } else {
                entities.push({idPattern: id_pattern});
            }

            this.connection.ld.createSubscription({
                id: "urn:ngsi-ld:Subscription:ngsi-ld-source-operator",
                type: "Subscription",
                entities: entities,
                notification: {
                    attrs: attributes != null ? attributes.split(/,\s*/) : undefined,
                    metadata: metadata != null ? metadata.split(/,\s*/) : undefined,
                    endpoint: {
                        callback: (notification) => {
                            handlerReceiveEntities.call(this, notification.data);
                        },
                        accept: "application/json"
                    }
                },
                "@context": [
                    "https://fiware.github.io/data-models/context.jsonld",
                    "https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld"
                ]
            }).then(
                (response) => {
                    MashupPlatform.operator.log("Subscription created successfully (id: " + response.subscription.id + ")", MashupPlatform.log.INFO);
                    this.subscriptionId = response.subscription.id;
                    this.refresh_interval = setInterval(refreshNGSISubscription.bind(this), 1000 * 60 * 60 * 2);  // each 2 hours
                    doInitialQueries.call(this, id_pattern, types, filter, attributes, metadata);
                },
                (e) => {
                    if (e instanceof NGSI.ProxyConnectionError) {
                        MashupPlatform.operator.log("Error connecting with the NGSI Proxy: " + e.cause.message);
                    } else {
                        MashupPlatform.operator.log("Error creating subscription in the context broker server: " + e.message);
                    }
                }
            );
        }
    };

    const requestInitialData = function requestInitialData(idPattern, types, filter, attributes, metadata, page) {
        return this.connection.ld.queryEntities(
            {
                idPattern: idPattern,
                type: types,
                count: true,
                limit: 100,
                offset: page * 100,
                q: filter,
                attrs: attributes,
                metadata: metadata
            }
        ).then(
            (response) => {
                handlerReceiveEntities.call(this, response.results);
                if (page < 100 && (page + 1) * 100 < response.count) {
                    return requestInitialData.call(this, idPattern, types, filter, attributes, metadata, page + 1);
                }
            },
            () => {
                MashupPlatform.operator.log("Error retrieving initial values");
            }
        );
    };

    const normalize2KeyValue = function normalize2KeyValue(entity) {
        // Transform to keyValue
        const result = {};
        for (const key in entity) {
            const at = entity[key];
            if (key === "id" || key === "type") {
                result[key] = at;
            } else {
                result[key] = at.value;
            }
        }
        return result;
    };

    const sendMetadata = function sendMetadata() {
        if (MashupPlatform.operator.outputs.ngsimetadata.connected) {
            const metadata = {
                types: MashupPlatform.prefs.get('ngsi_entities').trim().split(","),
                filteredAttributes: "",  // This widget does not have such information
                updateAttributes: MashupPlatform.prefs.get('ngsi_update_attributes').trim().split(","),
                // entity: response.result.entity, // For future support of fiware-ngsi-registry
                auth_type: "",  // Not present in NGSI-source
                idPattern: MashupPlatform.prefs.get('ngsi_id_filter').trim(),
                query: MashupPlatform.prefs.get('query').trim(),
                values: false, // Not needed in NGSI-source
                serverURL: MashupPlatform.prefs.get('ngsi_server').trim(),
                proxyURL: MashupPlatform.prefs.get('ngsi_proxy').trim(),
                servicePath: MashupPlatform.prefs.get('ngsi_service_path').trim(),
                tenant: MashupPlatform.prefs.get('ngsi_tenant').trim(),
                // use_owner_credentials: false,
                // use_user_fiware_token: false,
            };
            MashupPlatform.wiring.pushEvent('ngsimetadata', metadata);
        }
    };

    /* *************************** Preference Handler *****************************/

    const handlerPreferences = function handlerPreferences(new_values) {

        sendMetadata();

        if (this.refresh_interval) {
            clearInterval(this.refresh_interval);
            this.refresh_interval = null;
        }

        if (this.query_task != null) {
            this.query_task.abort(null, true);
            this.query_task = null;
        }

        if (this.subscriptionId != null) {
            this.connection.ld.deleteSubscription(this.subscriptionId).then(
                () => {
                    MashupPlatform.operator.log("Old subscription has been cancelled sucessfully", MashupPlatform.log.INFO);
                },
                () => {
                    MashupPlatform.operator.log("Error cancelling old subscription", MashupPlatform.log.WARN);
                }
            ).finally(() => {
                doInitialSubscription.call(this);
            });
            // Remove subscriptionId without waiting to know if the operator finished successfully
            this.subscriptionId = null;
        } else {
            doInitialSubscription.call(this);
        }
    };

    /* *****************************************************************************/
    /* ******************************** PUBLIC *************************************/
    /* *****************************************************************************/

    const NGSISource = function NGSISource() {
        this.connection = null; // The connection to NGSI.
        this.refresh_interval = null;
        this.query_task = null;
    };

    NGSISource.prototype.init = function init() {
        // Set preference callbacks
        MashupPlatform.prefs.registerCallback(handlerPreferences.bind(this));

        // Set beforeunload listener
        window.addEventListener("beforeunload", () => {
            if (this.query_task != null) {
                this.query_task.abort(null, true);
                this.query_task = null;
            }

            if (this.subscriptionId == null) {
                return;
            }

            this.connection.ld.deleteSubscription(this.subscriptionId).then(
                () => {
                    MashupPlatform.operator.log("Subscription cancelled sucessfully", MashupPlatform.log.INFO);
                },
                () => {
                    MashupPlatform.operator.log("Error cancelling current context broker subscription");
                }
            );
        });

        // Set wiring status callback
        MashupPlatform.wiring.registerStatusCallback(() => {
            if (this.connection == null) {
                doInitialSubscription.call(this);
            }
        });

        // Create NGSI conection
        doInitialSubscription.call(this);

        // Initial sent of configs on metadata output endpoint
        sendMetadata();
    };

    /* import-block */
    window.NGSISource = NGSISource;
    window.refreshNGSISubscription = refreshNGSISubscription;
    /* end-import-block */

    const ngsiSource = new NGSISource();
    window.addEventListener("DOMContentLoaded", ngsiSource.init.bind(ngsiSource), false);

})();