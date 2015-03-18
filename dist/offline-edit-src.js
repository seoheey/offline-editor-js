/*! offline-editor-js - v2.5 - 2015-03-17
*   Copyright (c) 2015 Environmental Systems Research Institute, Inc.
*   Apache License*/
define([
        "dojo/Evented",
        "dojo/_base/Deferred",
        "dojo/DeferredList",
        "dojo/promise/all",
        "dojo/_base/declare",
        "dojo/_base/array",
        "dojo/dom-attr",
        "dojo/dom-style",
        "dojo/query",
        "esri/config",
        "esri/layers/GraphicsLayer",
        "esri/graphic",
        "esri/symbols/SimpleMarkerSymbol",
        "esri/symbols/SimpleLineSymbol",
        "esri/symbols/SimpleFillSymbol",
        "esri/urlUtils"],
    function (Evented, Deferred, DeferredList, all, declare, array, domAttr, domStyle, query,
              esriConfig, GraphicsLayer, Graphic, SimpleMarkerSymbol, SimpleLineSymbol, SimpleFillSymbol, urlUtils) {
        "use strict";
        return declare("O.esri.Edit.OfflineFeaturesManager", [Evented],
            {
                _onlineStatus: "online",
                _featureLayers: {},
                _editStore: new O.esri.Edit.EditStore(),

                ONLINE: "online",				// all edits will directly go to the server
                OFFLINE: "offline",             // edits will be enqueued
                RECONNECTING: "reconnecting",   // sending stored edits to the server
                attachmentsStore: null,         // indexedDB for storing attachments
                proxyPath: null,                // by default we use CORS and therefore proxyPath is null

                // manager emits event when...
                events: {
                    EDITS_SENT: "edits-sent",           // ...whenever any edit is actually sent to the server
                    EDITS_ENQUEUED: "edits-enqueued",   // ...when an edit is enqueued (and not sent to the server)
                    EDITS_ENQUEUED_ERROR: "edits-enqueued-error", // ...when there is an error during the queing process
                    EDITS_SENT_ERROR: "edits-sent-error",         // ...there was a problem with one or more edits!
                    ALL_EDITS_SENT: "all-edits-sent",   // ...after going online and there are no pending edits in the queue
                    ATTACHMENT_ENQUEUED: "attachment-enqueued",
                    ATTACHMENTS_SENT: "attachments-sent"
                },

                /**
                 * Need to call this method only if you want to support offline attachments
                 * it is optional
                 * @param callback(success)
                 * @returns void
                 */
                initAttachments: function (callback) {
                    callback = callback || function (success) {
                        console.log("attachments inited ", success ? "ok" : "failed");
                    };

                    if (!this._checkFileAPIs()) {
                        return callback(false, "File APIs not supported");
                    }

                    try {
                        this.attachmentsStore = new O.esri.Edit.AttachmentsStore();

                        if (/*false &&*/ this.attachmentsStore.isSupported()) {
                            this.attachmentsStore.init(callback);
                        }
                        else {
                            return callback(false, "indexedDB not supported");
                        }
                    }
                    catch (err) {
                        console.log("problem!  " + err.toString());
                    }
                },

                /**
                 * Overrides a feature layer. Call this AFTER the FeatureLayer's 'update-end' event.
                 * IMPORTANT: If options are specified they will be saved to the database. Any complex
                 * objects such as [esri.Graphic] will need to be serialized or you will get an error.
                 * @param layer
                 * @param updateEndEvent The FeatureLayer's update-end event object
                 * @param callback {true, null} or {false, errorString} Traps whether or not the database initialized
                 * @param options Optional configuration Object. Added @ v2.5
                 * @returns deferred
                 */
                extend: function (layer, callback, options) {
                    var self = this;

                    // Attempt to initialize the database
                    self._editStore.init(function (result) {

                        ////////////////////////////////////////////////////
                        // OFFLINE RESTART CONFIGURATION
                        // Added @ v2.5
                        //
                        // Configure database for offline restart
                        // If options Object is not defined the do nothing.
                        //
                        //

                        if (typeof options == "object") {
                            self._editStore.pushFeatureLayerJSON(options, function (success, err) {
                                if (success) {
                                    callback(true, null);
                                }
                                else {
                                    callback(false, err);
                                }
                            })
                        }
                    });

                    // we keep track of the FeatureLayer object
                    this._featureLayers[layer.url] = layer;

                    // replace the applyEdits() method
                    layer._applyEdits = layer.applyEdits;


                    // attachments
                    layer._addAttachment = layer.addAttachment;
                    layer._queryAttachmentInfos = layer.queryAttachmentInfos;
                    layer._deleteAttachments = layer.deleteAttachments;

                    /*
                     operations supported offline:
                     1. add a new attachment to an existing feature (DONE)
                     2. add a new attachment to a new feature (DONE)
                     3. remove an attachment that is already in the server... (NOT YET)
                     4. remove an attachment that is not in the server yet (DONE)
                     5. update an existing attachment to an existing feature (NOT YET)
                     6. update a new attachment (NOT YET)

                     concerns:
                     - manage the relationship between offline features and attachments: what if the user wants to add
                     an attachment to a feature that is still offline? we need to keep track of objectids so that when
                     the feature is sent to the server and receives a final objectid we replace the temporary negative id
                     by its final objectid (DONE)
                     - what if the user deletes an offline feature that had offline attachments? we need to discard the attachment  (DONE)

                     pending tasks:
                     - check for hasAttachments attribute in the FeatureLayer (NOT YET)
                     */

                    //
                    // attachments
                    //
                    layer.queryAttachmentInfos = function (objectId, callback, errback) {
                        if (self.getOnlineStatus() === self.ONLINE) {
                            var def = this._queryAttachmentInfos(objectId,
                                function () {
                                    console.log(arguments);
                                    self.emit(self.events.ATTACHMENTS_INFO, arguments);
                                    callback && callback.apply(this, arguments);
                                },
                                errback);
                            return def;
                        }

                        if (!self.attachmentsStore) {
                            console.log("in order to support attachments you need to call initAttachments() method of offlineFeaturesManager");
                            return;
                        }

                        // will only return LOCAL attachments
                        var deferred = new Deferred();
                        self.attachmentsStore.getAttachmentsByFeatureId(this.url, objectId, function (attachments) {
                            callback && callback(attachments);
                            deferred.resolve(attachments);
                        });
                        return deferred;
                    };

                    layer.addAttachment = function (objectId, formNode, callback, errback) {
                        if (self.getOnlineStatus() === self.ONLINE) {
                            return this._addAttachment(objectId, formNode,
                                function () {
                                    console.log(arguments);
                                    self.emit(self.events.ATTACHMENTS_SENT, arguments);
                                    callback && callback.apply(this, arguments);
                                },
                                function (err) {
                                    console.log("addAttachment: " + err);
                                    errback && errback.apply(this, arguments);
                                }
                            );
                        }

                        if (!self.attachmentsStore) {
                            console.log("in order to support attachments you need to call initAttachments() method of offlineFeaturesManager");
                            return;
                        }

                        var files = this._getFilesFromForm(formNode);
                        var file = files[0]; // addAttachment can only add one file, so the rest -if any- are ignored

                        var deferred = new Deferred();
                        var attachmentId = this._getNextTempId();
                        self.attachmentsStore.store(this.url, attachmentId, objectId, file, function (success, newAttachment) {
                            var returnValue = {attachmentId: attachmentId, objectId: objectId, success: success};
                            if (success) {
                                self.emit(self.events.ATTACHMENT_ENQUEUED, returnValue);
                                callback && callback(returnValue);
                                deferred.resolve(returnValue);

                                // replace the default URL that is set by attachmentEditor with the local file URL
                                var attachmentUrl = this._url.path + "/" + objectId + "/attachments/" + attachmentId;
                                var attachmentElement = query("[href=" + attachmentUrl + "]");
                                attachmentElement.attr("href", newAttachment.url);
                            }
                            else {
                                returnValue.error = "can't store attachment";
                                errback && errback(returnValue);
                                deferred.reject(returnValue);
                            }
                        }.bind(this));

                        return deferred;
                    };

                    layer.deleteAttachments = function (objectId, attachmentsIds, callback, errback) {
                        if (self.getOnlineStatus() === self.ONLINE) {
                            var def = this._deleteAttachments(objectId, attachmentsIds,
                                function () {
                                    callback && callback.apply(this, arguments);
                                },
                                function (err) {
                                    console.log("deleteAttachments: " + err);
                                    errback && errback.apply(this, arguments);
                                });
                            return def;
                        }

                        if (!self.attachmentsStore) {
                            console.log("in order to support attachments you need to call initAttachments() method of offlineFeaturesManager");
                            return;
                        }

                        // case 1.- it is a new attachment
                        // case 2.- it is an already existing attachment
                        // only case 1 is supported right now

                        // asynchronously delete each of the attachments
                        var promises = [];
                        attachmentsIds.forEach(function (attachmentId) {
                            attachmentId = parseInt(attachmentId, 10); // to number
                            console.assert(attachmentId < 0, "we only support deleting local attachments");
                            var deferred = new Deferred();
                            self.attachmentsStore.delete(attachmentId, function (success) {
                                var result = {objectId: objectId, attachmentId: attachmentId, success: success};
                                deferred.resolve(result);
                            });
                            promises.push(deferred);
                        }, this);

                        // call callback once all deletes have finished
                        var allPromises = all(promises);
                        allPromises.then(function (results) {
                            callback && callback(results);
                        });

                        return allPromises;
                    };

                    //
                    // other functions
                    //

                    /**
                     * Overrides the ArcGIS API for JavaSccript applyEdits() method.
                     * @param adds Creates a new edit entry.
                     * @param updates Updates an existing entry.
                     * @param deletes Deletes an existing entry.
                     * @param callback Called when the operation is complete.
                     * @param errback  An error object is returned if an error occurs
                     * @returns {*} deferred
                     * @throws EDITS_ENQUEUED if all edits successfully stored while offline
                     * @throws EDITS_ENQUEUED_ERROR if there was an error while storing an edit while offline
                     */
                    layer.applyEdits = function (adds, updates, deletes, callback, errback) {
                        // inside this method, 'this' will be the FeatureLayer
                        // and 'self' will be the offlineFeatureLayer object

                        var promises = [];

                        if (self.getOnlineStatus() === self.ONLINE) {
                            var def = this._applyEdits(adds, updates, deletes,
                                function () {
                                    self.emit(self.events.EDITS_SENT, arguments);
                                    callback && callback.apply(this, arguments);
                                },
                                errback);
                            return def;
                        }

                        var deferred = new Deferred();
                        var results = {addResults: [], updateResults: [], deleteResults: []};
                        var updatesMap = {};

                        this.onBeforeApplyEdits(adds, updates, deletes);

                        adds = adds || [];
                        adds.forEach(function (addEdit) {
                            var deferred = new Deferred();

                            var objectId = this._getNextTempId();
                            addEdit.attributes[this.objectIdField] = objectId;

                            self._editStore.pushEdit(self._editStore.ADD, this.url, addEdit, function (result, error) {
                                result == true ? deferred.resolve(result) : deferred.reject(error);
                            });
                            results.addResults.push({success: true, error: null, objectId: objectId});

                            var phantomAdd = new Graphic(
                                addEdit.geometry,
                                self._getPhantomSymbol(addEdit.geometry, self._editStore.ADD),
                                {
                                    objectId: objectId
                                });

                            // Add phantom graphic to the layer
                            this._phantomLayer.add(phantomAdd);

                            // Add phantom graphic to the database
                            self._editStore.pushPhantomGraphic(phantomAdd, function (result) {
                                if (!result)console.log("There was a problem adding phantom graphic id: " + objectId);
                                console.log("Phantom graphic " + objectId + " added to database as an add.");
                            });

                            domAttr.set(phantomAdd.getNode(), "stroke-dasharray", "10,4");
                            domStyle.set(phantomAdd.getNode(), "pointer-events", "none");

                            promises.push(deferred);
                        }, this);

                        updates = updates || [];
                        updates.forEach(function (updateEdit) {
                            var deferred = new Deferred();

                            var objectId = updateEdit.attributes[this.objectIdField];
                            updatesMap[objectId] = updateEdit;

                            self._editStore.pushEdit(self._editStore.UPDATE, this.url, updateEdit, function (result, error) {
                                result == true ? deferred.resolve(result) : deferred.reject(error);
                            });
                            results.updateResults.push({success: true, error: null, objectId: objectId});

                            var phantomUpdate = new Graphic(
                                updateEdit.geometry,
                                self._getPhantomSymbol(updateEdit.geometry, self._editStore.UPDATE),
                                {
                                    objectId: objectId
                                });
                            this._phantomLayer.add(phantomUpdate);

                            // Add phantom graphic to the database
                            self._editStore.pushPhantomGraphic(phantomUpdate, function (result) {
                                if (!result)console.log("There was a problem adding phantom graphic id: " + objectId);
                                console.log("Phantom graphic " + objectId + " added to database as an update.");
                            });

                            domAttr.set(phantomUpdate.getNode(), "stroke-dasharray", "5,2");
                            domStyle.set(phantomUpdate.getNode(), "pointer-events", "none");

                            promises.push(deferred);
                        }, this);

                        deletes = deletes || [];
                        deletes.forEach(function (deleteEdit) {
                            var deferred = new Deferred();

                            var objectId = deleteEdit.attributes[this.objectIdField];
                            self._editStore.pushEdit(self._editStore.DELETE, this.url, deleteEdit, function (result, error) {
                                result == true ? deferred.resolve(result) : deferred.reject(error);
                            });
                            results.deleteResults.push({success: true, error: null, objectId: objectId});

                            var phantomDelete = new Graphic(
                                deleteEdit.geometry,
                                self._getPhantomSymbol(deleteEdit.geometry, self._editStore.DELETE),
                                {
                                    objectId: objectId
                                });
                            this._phantomLayer.add(phantomDelete);

                            // Add phantom graphic to the database
                            self._editStore.pushPhantomGraphic(phantomDelete, function (result) {
                                if (!result)console.log("There was a problem adding phantom graphic id: " + objectId);
                                console.log("Phantom graphic " + objectId + " added to database as a deletion.");
                            });

                            domAttr.set(phantomDelete.getNode(), "stroke-dasharray", "4,4");
                            domStyle.set(phantomDelete.getNode(), "pointer-events", "none");

                            if (self.attachmentsStore) {
                                // delete local attachments of this feature, if any... we just launch the delete and don't wait for it to complete
                                self.attachmentsStore.deleteAttachmentsByFeatureId(this.url, objectId, function (deletedCount) {
                                    console.log("deleted", deletedCount, "attachments of feature", objectId);
                                });
                            }

                            promises.push(deferred);
                        }, this);

                        all(promises).then(function (r) {
                            // Make sure all edits were successful. If not throw an error.
                            var success = true;
                            var length = r.length;
                            for (var v = 0; v < length; v++) {
                                if (r[v] == false) success = false;
                            }

                            /* we already pushed the edits into the database, now we let the FeatureLayer to do the local updating of the layer graphics */
                            setTimeout(function () {
                                this._editHandler(results, adds, updatesMap, callback, errback, deferred);
                                success == true ? self.emit(self.events.EDITS_ENQUEUED, results) : self.emit(self.events.EDITS_ENQUEUED_ERROR, results);
                            }.bind(this), 0);
                            return deferred;
                        }.bind(this));

                    }; // layer.applyEdits()

                    /**
                     * Converts an array of graphics/features into JSON
                     * @param features
                     * @param updateEndEvent The layer's 'update-end' event
                     * @param callback
                     */
                    layer.convertGraphicLayerToJSON = function (features, updateEndEvent, callback) {
                        var layerDefinition = {};
                        layerDefinition.objectIdFieldName = updateEndEvent.target.objectIdField;
                        layerDefinition.globalIdFieldName = updateEndEvent.target.globalIdField;
                        layerDefinition.geometryType = updateEndEvent.target.geometryType;
                        layerDefinition.spatialReference = updateEndEvent.target.spatialReference;
                        layerDefinition.fields = updateEndEvent.target.fields;

                        var length = features.length;
                        var jsonArray = [];
                        for (var i = 0; i < length; i++) {
                            var jsonGraphic = features[i].toJson();
                            jsonArray.push(jsonGraphic);
                            if (i == (length - 1)) {
                                var featureJSON = JSON.stringify(jsonArray);
                                var layerDefJSON = JSON.stringify(layerDefinition);
                                callback(featureJSON, layerDefJSON);
                                break;
                            }
                        }
                    };

                    /**
                     * Retrieves f=json from the feature layer
                     * @param url FeatureLayer's URL
                     * @param callback
                     * @private
                     */
                    layer.getFeatureLayerJSON = function (url, callback) {
                        require(["esri/request"], function (esriRequest) {
                            var request = esriRequest({
                                url: url,
                                content: {f: "json"},
                                handleAs: "json",
                                callbackParamName: "callback"
                            });

                            request.then(function (response) {
                                console.log("Success: ", response);
                                callback(true, response);
                            }, function (error) {
                                console.log("Error: ", error.message);
                                callback(false, error.message);
                            });
                        })
                    };

                    /**
                     * Serialize the feature layer graphics
                     * @param features
                     * @param callback
                     */
                    layer.convertFeatureGraphicsToJSON = function (features, callback) {
                        var length = features.length;
                        var jsonArray = [];
                        for (var i = 0; i < length; i++) {
                            var jsonGraphic = features[i].toJson();
                            jsonArray.push(jsonGraphic);
                            if (i == (length - 1)) {
                                var featureJSON = JSON.stringify(jsonArray);
                                callback(featureJSON);
                                break;
                            }
                        }
                    };

                    /**
                     * Sets the phantom layer with new features.
                     * Used to restore PhantomGraphicsLayer after offline restart
                     * @param graphicsArray an array of Graphics
                     */
                    layer.setPhantomLayerGraphics = function (graphicsArray) {
                        var length = graphicsArray.length;

                        if (length > 0) {
                            for (var i = 0; i < length; i++) {
                                var graphic = new Graphic(graphicsArray[i]);
                                this._phantomLayer.add(graphic);
                            }
                        }
                    };

                    /**
                     * Returns the array of graphics from the phantom graphics layer.
                     * This layer identifies features that have been modified
                     * while offline.
                     * @returns {array}
                     */
                    layer.getPhantomLayerGraphics = function (callback) {
                        //return layer._phantomLayer.graphics;
                        var graphics = layer._phantomLayer.graphics;
                        var length = layer._phantomLayer.graphics.length;
                        var jsonArray = [];
                        for (var i = 0; i < length; i++) {
                            var jsonGraphic = graphics[i].toJson();
                            jsonArray.push(jsonGraphic);
                            if (i == (length - 1)) {
                                var graphicsJSON = JSON.stringify(jsonArray);
                                callback(graphicsJSON);
                                break;
                            }
                        }
                    };

                    /**
                     * Create a featureDefinition
                     * @param featureLayer
                     * @param featuresArr
                     * @param geometryType
                     * @param callback
                     */
                    layer.getFeatureDefinition = function (/* Object */ featureLayer, /* Array */ featuresArr, /* String */ geometryType, callback) {

                        var featureDefinition = {
                            "layerDefinition": featureLayer,
                            "featureSet": {
                                "features": featuresArr,
                                "geometryType": geometryType
                            }

                        };

                        callback(featureDefinition);
                    };

                    /* internal methods */

                    layer._getFilesFromForm = function (formNode) {
                        var files = [];
                        var inputNodes = array.filter(formNode.elements, function (node) {
                            return node.type === "file";
                        });
                        inputNodes.forEach(function (inputNode) {
                            files.push.apply(files, inputNode.files);
                        }, this);
                        return files;
                    };

                    layer._replaceFeatureIds = function (tempObjectIds, newObjectIds, callback) {
                        console.log("replacing ids of attachments", tempObjectIds, newObjectIds);
                        console.assert(tempObjectIds.length === newObjectIds.length, "arrays must be the same length");

                        if (!tempObjectIds.length) {
                            console.log("no ids to replace!");
                            callback(0);
                        }

                        var i, n = tempObjectIds.length;
                        var count = n;
                        var successCount = 0;
                        for (i = 0; i < n; i++) {
                            self.attachmentsStore.replaceFeatureId(this.url, tempObjectIds[i], newObjectIds[i], function (success) {
                                --count;
                                successCount += (success ? 1 : 0);
                                if (count === 0) {
                                    callback(successCount);
                                }
                            }.bind(this));
                        }
                    };

                    // we need to identify ADDs before sending them to the server
                    // we assign temporary ids (using negative numbers to distinguish them from real ids)
                    layer._nextTempId = -1;
                    layer._getNextTempId = function () {
                        return this._nextTempId--;
                    };

                    function _initPhantomLayer() {
                        try {
                            layer._phantomLayer = new GraphicsLayer({opacity: 0.8});
                            layer._map.addLayer(layer._phantomLayer);
                        }
                        catch (err) {
                            console.log("Unable to init PhantomLayer");
                        }
                    }

                    _initPhantomLayer();

                }, // extend

                /**
                 * Forces library into an offline state. Any edits applied during this condition will be stored locally
                 */
                goOffline: function () {
                    console.log("offlineFeatureManager going offline");
                    this._onlineStatus = this.OFFLINE;
                },

                /**
                 * Forces library to return to an online state. If there are pending edits,
                 * an attempt will be made to sync them with the remote feature server
                 * @param callback callback( boolean, errors )
                 */
                goOnline: function (callback) {
                    console.log("offlineFeaturesManager going online");
                    this._onlineStatus = this.RECONNECTING;
                    this._replayStoredEdits(function (success, responses) {
                        var result = {features: {success: success, responses: responses}};
                        if (this.attachmentsStore != null) {
                            console.log("sending attachments");
                            this._sendStoredAttachments(function (success, responses) {
                                this._onlineStatus = this.ONLINE;
                                result.attachments = {success: success, responses: responses};
                                callback && callback(result);
                            }.bind(this));
                        }
                        else {
                            this._onlineStatus = this.ONLINE;
                            callback && callback(result);
                        }
                    }.bind(this));
                },

                /**
                 * Determines if offline or online condition exists
                 * @returns {string} ONLINE or OFFLINE
                 */
                getOnlineStatus: function () {
                    return this._onlineStatus;
                },

                /* internal methods */

                /**
                 * internal method that checks if this browser supports everything that is needed to handle offline attachments
                 * it also extends XMLHttpRequest with sendAsBinary() method, needed in Chrome
                 */
                _checkFileAPIs: function () {
                    if (window.File && window.FileReader && window.FileList && window.Blob) {
                        console.log("All APIs supported!");

                        if (!XMLHttpRequest.prototype.sendAsBinary) {
                            // https://code.google.com/p/chromium/issues/detail?id=35705#c40
                            XMLHttpRequest.prototype.sendAsBinary = function (datastr) {
                                function byteValue(x) {
                                    return x.charCodeAt(0) & 0xff;
                                }

                                var ords = Array.prototype.map.call(datastr, byteValue);
                                var ui8a = new Uint8Array(ords);
                                this.send(ui8a.buffer);
                            };
                            console.log("extending XMLHttpRequest");
                        }
                        return true;
                    }
                    console.log("The File APIs are not fully supported in this browser.");
                    return false;
                },

                /**
                 * internal method that extends an object with sendAsBinary() method
                 * sometimes extending XMLHttpRequest.prototype is not enough, as ArcGIS JS lib seems to mess with this object too
                 * @param oAjaxReq object to extend
                 */
                _extendAjaxReq: function (oAjaxReq) {
                    oAjaxReq.sendAsBinary = XMLHttpRequest.prototype.sendAsBinary;
                    console.log("extending XMLHttpRequest");
                },

                //
                // phantom symbols
                //

                _phantomSymbols: [],

                _getPhantomSymbol: function (geometry, operation) {
                    if (this._phantomSymbols.length === 0) {
                        var color = [0, 255, 0, 255];
                        var width = 1.5;

                        this._phantomSymbols['point'] = [];
                        this._phantomSymbols['point'][this._editStore.ADD] = new SimpleMarkerSymbol({
                            "type": "esriSMS", "style": "esriSMSCross",
                            "xoffset": 10, "yoffset": 10,
                            "color": [255, 255, 255, 0], "size": 15,
                            "outline": {"color": color, "width": width, "type": "esriSLS", "style": "esriSLSSolid"}
                        });
                        this._phantomSymbols['point'][this._editStore.UPDATE] = new SimpleMarkerSymbol({
                            "type": "esriSMS", "style": "esriSMSCircle",
                            "xoffset": 0, "yoffset": 0,
                            "color": [255, 255, 255, 0], "size": 15,
                            "outline": {"color": color, "width": width, "type": "esriSLS", "style": "esriSLSSolid"}
                        });
                        this._phantomSymbols['point'][this._editStore.DELETE] = new SimpleMarkerSymbol({
                            "type": "esriSMS", "style": "esriSMSX",
                            "xoffset": 0, "yoffset": 0,
                            "color": [255, 255, 255, 0], "size": 15,
                            "outline": {"color": color, "width": width, "type": "esriSLS", "style": "esriSLSSolid"}
                        });
                        this._phantomSymbols['multipoint'] = null;

                        this._phantomSymbols['polyline'] = [];
                        this._phantomSymbols['polyline'][this._editStore.ADD] = new SimpleLineSymbol({
                            "type": "esriSLS", "style": "esriSLSSolid",
                            "color": color, "width": width
                        });
                        this._phantomSymbols['polyline'][this._editStore.UPDATE] = new SimpleLineSymbol({
                            "type": "esriSLS", "style": "esriSLSSolid",
                            "color": color, "width": width
                        });
                        this._phantomSymbols['polyline'][this._editStore.DELETE] = new SimpleLineSymbol({
                            "type": "esriSLS", "style": "esriSLSSolid",
                            "color": color, "width": width
                        });

                        this._phantomSymbols['polygon'] = [];
                        this._phantomSymbols['polygon'][this._editStore.ADD] = new SimpleFillSymbol({
                            "type": "esriSFS",
                            "style": "esriSFSSolid",
                            "color": [255, 255, 255, 0],
                            "outline": {"type": "esriSLS", "style": "esriSLSSolid", "color": color, "width": width}
                        });
                        this._phantomSymbols['polygon'][this._editStore.UPDATE] = new SimpleFillSymbol({
                            "type": "esriSFS",
                            "style": "esriSFSSolid",
                            "color": [255, 255, 255, 0],
                            "outline": {"type": "esriSLS", "style": "esriSLSDash", "color": color, "width": width}
                        });
                        this._phantomSymbols['polygon'][this._editStore.DELETE] = new SimpleFillSymbol({
                            "type": "esriSFS",
                            "style": "esriSFSSolid",
                            "color": [255, 255, 255, 0],
                            "outline": {"type": "esriSLS", "style": "esriSLSDot", "color": color, "width": width}
                        });
                    }

                    return this._phantomSymbols[geometry.type][operation];
                },

                //
                // methods to handle attachment uploads
                //

                _fieldSegment: function (name, value) {
                    return "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n";
                },

                _fileSegment: function (fieldName, fileName, fileType, fileContent) {
                    return "Content-Disposition: form-data; name=\"" + fieldName +
                        "\"; filename=\"" + fileName +
                        "\"\r\nContent-Type: " + fileType + "\r\n\r\n" +
                        fileContent + "\r\n";
                },

                _uploadAttachment: function (attachment) {
                    var dfd = new Deferred();

                    var segments = [];
                    segments.push(this._fieldSegment("f", "json"));
                    segments.push(this._fileSegment("attachment", attachment.name, attachment.contentType, attachment.content));

                    var oAjaxReq = new XMLHttpRequest();

                    // surprisingly, sometimes the oAjaxReq object doesn't have the sendAsBinary() method, even if we added it to the XMLHttpRequest.prototype
                    if (!oAjaxReq.sendAsBinary) {
                        this._extendAjaxReq(oAjaxReq);
                    }

                    oAjaxReq.onload = function (result) {
                        dfd.resolve(JSON.parse(result.target.response));
                    };
                    oAjaxReq.onerror = function (err) {
                        dfd.reject(err);
                    };

                    // IMPORTANT!
                    // Proxy path can be set to null if feature service is CORS enabled
                    // Refer to "Using the Proxy Page" for more information:  https://developers.arcgis.com/en/javascript/jshelp/ags_proxy.html
                    var proxy = this.proxyPath || esriConfig.defaults.io.proxyUrl || "";
                    if (proxy !== "") {
                        proxy += "?";
                    }
                    console.log("proxy:", proxy);
                    oAjaxReq.open("post", proxy + attachment.featureId + "/addAttachment", true);
                    var sBoundary = "---------------------------" + Date.now().toString(16);
                    oAjaxReq.setRequestHeader("Content-Type", "multipart\/form-data; boundary=" + sBoundary);
                    oAjaxReq.sendAsBinary("--" + sBoundary + "\r\n" + segments.join("--" + sBoundary + "\r\n") + "--" + sBoundary + "--\r\n");

                    return dfd;
                },

                _deleteAttachment: function (attachmentId, uploadResult) {
                    var dfd = new Deferred();

                    console.log("upload complete", uploadResult, attachmentId);
                    this.attachmentsStore.delete(attachmentId, function (success) {
                        console.assert(success === true, "can't delete attachment already uploaded");
                        console.log("delete complete", success);
                        dfd.resolve(uploadResult);
                    });

                    return dfd;
                },

                _sendStoredAttachments: function (callback) {
                    this.attachmentsStore.getAllAttachments(function (attachments) {
                        console.log("we have", attachments.length, "attachments to upload");

                        var promises = [];
                        attachments.forEach(function (attachment) {
                            console.log("sending attachment", attachment.id, "to feature", attachment.featureId);
                            var deleteCompleted =
                                this._uploadAttachment(attachment)
                                    .then(function (uploadResult) {
                                        if (uploadResult.addAttachmentResult && uploadResult.addAttachmentResult.success === true) {
                                            console.log("upload success", uploadResult.addAttachmentResult.success);
                                            return this._deleteAttachment(attachment.id, uploadResult);
                                        }
                                        else {
                                            console.log("upload failed", uploadResult);
                                            return null;
                                        }
                                    }.bind(this),
                                    function (err) {
                                        console.log("failed uploading attachment", attachment);
                                    }
                                );
                            promises.push(deleteCompleted);
                        }, this);
                        console.log("promises", promises.length);
                        var allPromises = all(promises);
                        allPromises.then(function (results) {
                                console.log(results);
                                callback && callback(true, results);
                            },
                            function (err) {
                                console.log("error!", err);
                                callback && callback(false, err);
                            });
                    }.bind(this));
                },

                //
                // methods to send features back to the server
                //

                /**
                 * Attempts to send any edits in the database. Monitor events for success or failure.
                 * @param callback
                 * @throws EDITS_SENT when some edits have been successfully sent
                 * @throws ALL_EDITS_SENT when all edits have been successfully sent
                 * @throws EDITS_SENT_ERROR some edits were not sent successfully
                 * @private
                 */
                _replayStoredEdits: function (callback) {
                    var promises = {};
                    var that = this;

                    //
                    // send edits for each of the layers
                    //
                    var layer;
                    var adds = [], updates = [], deletes = [];
                    var tempObjectIds = [];
                    var tempArray = [];
                    var featureLayers = this._featureLayers;
                    var attachmentsStore = this.attachmentsStore;
                    var editStore = this._editStore;

                    this._editStore.getAllEditsArray(function (result, err) {
                        if (result.length > 0) {
                            tempArray = result;

                            var length = tempArray.length;

                            for (var n = 0; n < length; n++) {
                                layer = featureLayers[tempArray[n].layer];

                                // If the layer has attachments then check to see if the attachmentsStore has been initialized
                                if (attachmentsStore == null && layer.hasAttachments) {
                                    console.log("ERROR: you need to run OfflineFeaturesManager.initAttachments(). Check the Attachments doc for more info.");
                                    throw new Error("OfflineFeaturesManager: Attachments aren't initialized.");
                                }

                                // Assign the attachmentsStore to the layer as a private var so we can access it from
                                // the promises applyEdits() method.
                                layer._attachmentsStore = attachmentsStore;

                                layer.__onEditsComplete = layer.onEditsComplete;
                                layer.onEditsComplete = function () {
                                    console.log("intercepting events onEditsComplete");
                                };
                                layer.__onBeforeApplyEdits = layer.onBeforeApplyEdits;
                                layer.onBeforeApplyEdits = function () {
                                    console.log("intercepting events onBeforeApplyEdits");
                                };

                                // Let's zero everything out
                                adds = [], updates = [], deletes = [], tempObjectIds = [];

                                // IMPORTANT: reconstitute the graphic JSON into an actual esri.Graphic object
                                // NOTE: we are only sending one Graphic per loop!
                                var graphic = new Graphic(tempArray[n].graphic);

                                switch (tempArray[n].operation) {
                                    case editStore.ADD:
                                        for (var i = 0; i < layer.graphics.length; i++) {
                                            var g = layer.graphics[i];
                                            if (g.attributes[layer.objectIdField] === graphic.attributes[layer.objectIdField]) {
                                                layer.remove(g);
                                                break;
                                            }
                                        }
                                        tempObjectIds.push(graphic.attributes[layer.objectIdField]);
                                        delete graphic.attributes[layer.objectIdField];
                                        adds.push(graphic);
                                        break;
                                    case editStore.UPDATE:
                                        updates.push(graphic);
                                        break;
                                    case editStore.DELETE:
                                        deletes.push(graphic);
                                        break;
                                }

                                promises[n] = that._internalApplyEdits(layer, tempArray[n].id, tempObjectIds, adds, updates, deletes);
                            }

                        }

                        // wait for all requests to finish
                        //
                        var allPromises = all(promises);
                        allPromises.then(
                            function (responses) {
                                console.log("OfflineFeaturesManager - all responses are back");
                                this._cleanSuccessfulEditsDatabaseRecords(responses, function (success, error) {
                                    console.log("CLEANED EDITS DATABASE");
                                    if (success) {

                                        this._editStore.resetLimitedPhantomGraphicsQueue(responses, function (success) {
                                            console.log("CLEAR PHANTOM GRAPHICS " + JSON.stringify(responses))
                                        });

                                        this._editStore.resetPhantomGraphicsQueue(function (success) {

                                            this.emit(this.events.EDITS_SENT);

                                            if (success == false) {
                                                console.log("There was a problem deleting phantom graphics in the database.");
                                                this.emit(this.events.EDITS_SENT_ERROR, {msg: "Problem deleting phantom graphic(s)"});
                                            }
                                            else {
                                                this.emit(this.events.ALL_EDITS_SENT);
                                            }
                                            callback && callback(true, responses);
                                        }.bind(this))
                                    }
                                    else {
                                        this.emit(this.events.EDITS_SENT_ERROR, {msg: error}); // There was a problem, some edits were not successfully sent!
                                        callback && callback(false, responses);
                                    }
                                }.bind(that));
                            }.bind(that),
                            function (errors) {
                                console.log("OfflineFeaturesManager - ERROR!!");
                                console.log(errors);
                                callback && callback(false, errors);
                            }.bind(that)
                        );
                    });
                },

                /**
                 * Only delete items from database that were verified as successfully updated on the server.
                 * @param responses Object
                 * @param callback callback(true, responses) or callback(false, responses)
                 * @private
                 */
                _cleanSuccessfulEditsDatabaseRecords: function (responses, callback) {
                    if (Object.keys(responses).length !== 0) {

                        var editsArray = [];
                        var editsFailedArray = [];

                        for (var key in responses) {
                            if (responses.hasOwnProperty(key)) {

                                var edit = responses[key];
                                var tempResult = {};

                                if (edit.updateResults.length > 0) {
                                    if (edit.updateResults[0].success) {
                                        tempResult.layer = edit.layer;
                                        tempResult.id = edit.updateResults[0].objectId;
                                        editsArray.push(tempResult);
                                    }
                                    else {
                                        editsFailedArray.push(edit);
                                    }
                                }
                                if (edit.deleteResults.length > 0) {
                                    if (edit.deleteResults[0].success) {
                                        tempResult.layer = edit.layer;
                                        tempResult.id = edit.deleteResults[0].objectId;
                                        editsArray.push(tempResult);
                                    }
                                    else {
                                        editsFailedArray.push(edit);
                                    }
                                }
                                if (edit.addResults.length > 0) {
                                    if (edit.addResults[0].success) {
                                        tempResult.layer = edit.layer;
                                        tempResult.id = edit.tempId;
                                        editsArray.push(tempResult);
                                    }
                                    else {
                                        editsFailedArray.push(edit);
                                    }
                                }
                            }
                        }

                        var promises = {};
                        var length = editsArray.length;
                        for (var i = 0; i < length; i++) {
                            promises[i] = this._updateDatabase(editsArray[i]);
                        }
                        //console.log("EDIT LIST " + JSON.stringify(editsArray));

                        // wait for all requests to finish
                        //
                        var allPromises = all(promises);
                        allPromises.then(
                            function (responses) {
                                editsFailedArray.length > 0 ? callback(false, responses) : callback(true, responses);
                            },
                            function (errors) {
                                callback(false, errors);
                            }
                        );
                    }
                    else {
                        callback(true, {});
                    }
                },

                /**
                 * Deletes items from database
                 * @param edit
                 * @returns {l.Deferred.promise|*|c.promise|q.promise|promise}
                 * @private
                 */
                _updateDatabase: function (edit) {
                    var dfd = new Deferred();
                    var fakeGraphic = {};
                    fakeGraphic.attributes = {};
                    fakeGraphic.attributes.objectid = edit.id;

                    this._editStore.delete(edit.layer, fakeGraphic, function (success, error) {
                        if (success) {

                            var id = this._editStore.PHANTOM_GRAPHIC_PREFIX + this._editStore._PHANTOM_PREFIX_TOKEN + edit.id;
                            console.log("PHANTOM DELETE ID " + id);
                            //this.deletePhantomGraphic()

                            dfd.resolve({success: true, error: null});
                        }
                        else {
                            dfd.reject({success: false, error: error});
                        }
                    }.bind(this));

                    return dfd.promise;

                },

                /**
                 * Retrieves f=json from the feature layer
                 * @param url FeatureLayer's URL
                 * @param callback
                 * @private
                 */
                getFeatureLayerJSON: function (url, callback) {
                    require(["esri/request"], function (esriRequest) {
                        var request = esriRequest({
                            url: url,
                            content: {f: "json"},
                            handleAs: "json",
                            callbackParamName: "callback"
                        });

                        request.then(function (response) {
                            console.log("Success: ", response);
                            callback(true, response);
                        }, function (error) {
                            console.log("Error: ", error.message);
                            callback(false, error.message);
                        });
                    })
                },

                /**
                 * Executes the _applyEdits() method
                 * @param layer
                 * @param id the unique id that identifies the Graphic in the database
                 * @param tempObjectIds
                 * @param adds
                 * @param updates
                 * @param deletes
                 * @returns {l.Deferred.promise} contains {id,layer,tempId,addResults,updateResults,deleteResults}
                 * @private
                 */
                _internalApplyEdits: function (layer, id, tempObjectIds, adds, updates, deletes) {
                    var dfd = new Deferred();

                    layer._applyEdits(adds, updates, deletes,
                        function (addResults, updateResults, deleteResults) {
                            layer._phantomLayer.clear();

                            layer.onBeforeApplyEdits = layer.__onBeforeApplyEdits;
                            delete layer.__onBeforeApplyEdits;
                            var newObjectIds = addResults.map(function (r) {
                                return r.objectId;
                            });

                            // We use a different pattern if the attachmentsStore is valid and the layer has attachments
                            if (layer._attachmentsStore != null && layer.hasAttachments && tempObjectIds.length > 0) {
                                layer._replaceFeatureIds(tempObjectIds, newObjectIds, function (success) {
                                    dfd.resolve({
                                        id: id,
                                        layer: layer.url,
                                        tempId: tempObjectIds, // let's us internally match an ADD to it's new ObjectId
                                        addResults: addResults,
                                        updateResults: updateResults,
                                        deleteResults: deleteResults
                                    }); // wrap three arguments in a single object
                                });
                            }
                            else {
                                dfd.resolve({
                                    id: id,
                                    layer: layer.url,
                                    tempId: tempObjectIds, // let's us internally match an ADD to it's new ObjectId
                                    addResults: addResults,
                                    updateResults: updateResults,
                                    deleteResults: deleteResults
                                }); // wrap three arguments in a single object
                            }
                        },
                        function (error) {
                            layer.onEditsComplete = layer.__onEditsComplete;
                            delete layer.__onEditsComplete;
                            layer.onBeforeApplyEdits = layer.__onBeforeApplyEdits;
                            delete layer.__onBeforeApplyEdits;
                            dfd.reject(error);
                        }
                    );
                    return dfd.promise;
                },

                /**
                 * DEPRECATED @ v2.5
                 * @returns {{}}
                 * @private
                 */
                _optimizeEditsQueue: function () {
                    var optimizedEdits = {},
                        editCount = this._editStore.pendingEditsCount(),
                        optimizedCount = 0;

                    var edit, layer;
                    var layerEdits, objectId;

                    while (this._editStore.hasPendingEdits()) {
                        edit = this._editStore.popFirstEdit();
                        layer = this._featureLayers[edit.layer];

                        if (!(edit.layer in optimizedEdits)) {
                            optimizedEdits[edit.layer] = {};
                        }

                        layerEdits = optimizedEdits[edit.layer];
                        objectId = edit.graphic.attributes[layer.objectIdField];

                        if (!( objectId in layerEdits)) {
                            // first edit we see of this feature, no optimization to apply
                            layerEdits[objectId] = edit;
                            optimizedCount += 1;
                        }
                        else {
                            // we already have seen one edit for this same feature... we can merge the two edits in a single operation
                            switch (edit.operation) {
                                case this._editStore.ADD:
                                    /* impossible!! */
                                    throw("can't add the same feature twice!");
                                case this._editStore.UPDATE:
                                    layerEdits[objectId].graphic = edit.graphic;
                                    break;
                                case this._editStore.DELETE:
                                    if (objectId < 0) {
                                        delete layerEdits[objectId];
                                        optimizedCount -= 1;
                                    }
                                    else {
                                        layerEdits[objectId].operation = this._editStore.DELETE;
                                    }
                                    break;
                            }
                        }
                        if (Object.keys(layerEdits).length === 0) {
                            delete optimizedEdits[edit.layer];
                        }
                    }

                    console.log("optimized", editCount, "edits into", optimizedCount, "edits of", Object.keys(optimizedEdits).length, "layers");
                    return optimizedEdits;
                },

                /**
                 * DEPRECATED @ v2.5
                 * A string value representing human readable information on pending edits
                 * @param edit
                 * @returns {string}
                 */
                getReadableEdit: function (edit) {
                    var layer = this._featureLayers[edit.layer];
                    var graphic = this._editStore._deserialize(edit.graphic);
                    var readableGraphic = graphic.geometry.type;
                    var layerId = edit.layer.substring(edit.layer.lastIndexOf("/") + 1);
                    if (layer) {
                        readableGraphic += " [id=" + graphic.attributes[layer.objectIdField] + "]";
                    }
                    return "o:" + edit.operation + ", l:" + layerId + ", g:" + readableGraphic;
                }

            }); // declare
    }); // define

/**
 * Creates a namespace for the non-AMD libraries in this directory
 */


if(typeof O != "undefined"){
    O.esri.Edit = {}
}
else{
    O = {};
    O.esri = {
        Edit: {}
    }
}

"use strict";

/*global IDBKeyRange,indexedDB */

"use strict";
O.esri.Edit.EditStore = function () {
    this._db = null;

    // Public properties

    var dbName = "features_store";
    var objectStoreName = "features";
    var dbIndex = "featureId";

    // ENUMs

    this.ADD = "add";
    this.UPDATE = "update";
    this.DELETE = "delete";

    this.FEATURE_LAYER_JSON_ID = "feature-layer-object-1001";
    this.PHANTOM_GRAPHIC_PREFIX = "phantom-layer";
    this._PHANTOM_PREFIX_TOKEN = "|@|";

    this.isSupported = function () {
        if (!window.indexedDB) {
            return false;
        }
        return true;
    };

    /**
     * Commit an edit to the database
     * @param operation add, update or delete
     * @param layerUrl the URL of the feature layer
     * @param graphic esri/graphic. The method will serialize to JSON
     * @param callback {true, edit} or {false, error}
     */
    this.pushEdit = function (operation, layerUrl, graphic, callback) {

        var edit = {
            id: layerUrl + "/" + graphic.attributes.objectid,
            operation: operation,
            layer: layerUrl,
            graphic: graphic.toJson()
        };

        var transaction = this._db.transaction([objectStoreName], "readwrite");

        transaction.oncomplete = function (event) {
            callback(true);
        };

        transaction.onerror = function (event) {
            callback(false, event.target.error.message);
        };

        var objectStore = transaction.objectStore(objectStoreName);
        objectStore.put(edit);
    };

    /**
     * Use this to store any static FeatureLayer or related JSON data related to your app that will assist in restoring
     * a FeatureLayer.
     *
     * Handles both adds and updates. It copies any object properties, so it will not, by default, overwrite the entire object.
     *
     * Example 1: If you just submit {featureLayerRenderer: {someJSON}} it will only update the featureLayerRenderer property
     * Example 2: This is a full example
     * {
     *      featureLayerJSON: ...,
     *      graphics: ..., // Serialized Feature Layer graphics. Must be serialized!
     *      renderer: ...,
     *      opacity: ...,
     *      outfields: ...,
     *      mode: ...,
     *      extent: ...,
     *      zoom: 7,
     *      lastEdit: ...
     * }
     *
     * NOTE: "dataObject.id" is a reserved property. If you use "id" in your object this method will break.
     * @param dataObject Object
     * @param callback callback(true, null) or callback(false, error)
     */
    this.pushFeatureLayerJSON = function (dataObject /*Object*/, callback) {

        console.assert(this._db !== null, "indexeddb not initialized");
        if (typeof dataObject != "object") {
            callback(false, "dataObject type is not an object.");
        }

        var db = this._db;
        dataObject.id = this.FEATURE_LAYER_JSON_ID;

        this.getFeatureLayerJSON(function (success, result) {

            if (success && typeof result !== "undefined") {

                var objectStore = db.transaction([objectStoreName], "readwrite").objectStore(objectStoreName);

                // Make a copy of the object
                for (var key in dataObject) {
                    if (dataObject.hasOwnProperty(key)) {
                        result[key] = dataObject[key];
                    }
                }

                // Insert the update into the database
                var updateFeatureLayerDataRequest = objectStore.put(result);

                updateFeatureLayerDataRequest.onsuccess = function () {
                    callback(true, null);
                }

                updateFeatureLayerDataRequest.onerror = function (err) {
                    callback(false, err);
                };
            }
            else {

                var transaction = db.transaction([objectStoreName], "readwrite");

                transaction.oncomplete = function (event) {
                    callback(true, null);
                };

                transaction.onerror = function (event) {
                    callback(false, event.target.error.message);
                };

                var objectStore = transaction.objectStore(objectStoreName);

                // Protect against data cloning errors since we don't validate the input object
                // Example: if you attempt to use an esri.Graphic in its native form you'll get a data clone error
                try {
                    objectStore.put(dataObject);
                }
                catch (err) {
                    callback(false, JSON.stringify(err));
                }
            }
        });
    };

    /**
     * Retrieve the FeatureLayer data object
     * @param callback callback(true, object) || callback(false, error)
     */
    this.getFeatureLayerJSON = function (callback) {

        console.assert(this._db !== null, "indexeddb not initialized");

        var objectStore = this._db.transaction([objectStoreName], "readwrite").objectStore(objectStoreName);

        //Get the entry associated with the graphic
        var objectStoreGraphicRequest = objectStore.get(this.FEATURE_LAYER_JSON_ID);

        objectStoreGraphicRequest.onsuccess = function () {
            var object = objectStoreGraphicRequest.result;
            if (typeof object != "undefined") {
                callback(true, object);
            }
            else {
                callback(false, "nothing found");
            }
        };

        objectStoreGraphicRequest.onerror = function (msg) {
            callback(false, msg);
        }
    };

    /**
     * Safe delete. Checks if id exists, then reverifies.
     * @param callback callback(boolean, {message: String})
     */
    this.deleteFeatureLayerJSON = function (callback) {
        // NOTE: the implementation of the IndexedDB spec has a design fault with respect to
        // handling deletes. The result of a delete operation is always designated as undefined.
        // What this means is that there is no way to tell if an operation was successful or not.
        // And, it will always return 'true.'
        //
        // In order to get around this we have to verify if after the attempted deletion operation
        // if the record is or is not in the database. Kinda dumb, but that's how IndexedDB works.
        //http://stackoverflow.com/questions/17137879/is-there-a-way-to-get-information-on-deleted-record-when-calling-indexeddbs-obj

        var db = this._db;
        var deferred = null;
        var self = this;

        var id = this.FEATURE_LAYER_JSON_ID;

        require(["dojo/Deferred"], function (Deferred) {
            deferred = new Deferred();

            // Step 4 - Then we check to see if the record actually exists or not.
            deferred.then(function (result) {
                    // IF the delete was successful, then the record should return an error because it doesn't exist.
                    // We aren't 100% sure how all platforms will perform so we also trap the promise for return results.
                    self.editExists(id).then(function (results) {
                            // If the result is false then in theory the id no longer exists
                            // and we should return 'true' to indicate a successful delete operation.
                            results.success == false ? callback(true, {message: "id does not exist"}) : callback(false, {message: null});
                        },
                        function (err) {
                            // If the result is false then in theory the id no longer exists
                            // and we should return 'true' to indicate a successful delete operation.
                            callback(true, {message: "id does not exist"}); //because we want this test to throw an error. That means item deleted.
                        })
                },
                // There was a problem with the delete operation on the database
                // This error message will come from editExists();
                function (err) {
                    callback(false, {message: "id does not exist"});
                });

            // Step 1 - lets see if record exits. If it does not then return callback. Otherwise,
            // continue on with the deferred.
            self.editExists(id).then(function (result) {
                    if (result && result.success) {

                        var objectStore = db.transaction([objectStoreName], "readwrite").objectStore(objectStoreName);

                        // Step 2 - go ahead and delete graphic
                        var objectStoreDeleteRequest = objectStore.delete(id);

                        // Step 3 - We know that the onsuccess will always fire unless something serious goes wrong.
                        // So we go ahead and resolve the deferred here.
                        objectStoreDeleteRequest.onsuccess = function () {
                            deferred.resolve(true);
                        };

                        objectStoreDeleteRequest.onerror = function (msg) {
                            deferred.reject({success: false, error: msg});
                        }
                    }
                    else {
                        deferred.reject({success: false, message: "id does not exist"})
                    }
                },
                // If there is an error in editExists()
                function (err) {
                    deferred.reject({success: false, message: err});
                });
        })
    };

    /**
     * Add a phantom graphic to the store.
     * IMPORTANT! Requires graphic to have an objectId
     * @param graphic
     * @param callback
     */
    this.pushPhantomGraphic = function (graphic, callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var db = this._db;
        var id = this.PHANTOM_GRAPHIC_PREFIX + this._PHANTOM_PREFIX_TOKEN + graphic.attributes.objectId;

        var object = {
            id: id,
            graphic: graphic.toJson()
        }

        var transaction = db.transaction([objectStoreName], "readwrite");

        transaction.oncomplete = function (event) {
            callback(true, null);
        };

        transaction.onerror = function (event) {
            callback(false, event.target.error.message);
        };

        var objectStore = transaction.objectStore(objectStoreName);
        objectStore.put(object);

    };

    /**
     * Return an array of phantom graphics
     * @param callback
     */
    this.getPhantomGraphicsArray = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");
        var editsArray = [];

        if (this._db !== null) {

            var phantomGraphicPrefix = this.PHANTOM_GRAPHIC_PREFIX;

            var transaction = this._db.transaction([objectStoreName])
                .objectStore(objectStoreName)
                .openCursor();

            transaction.onsuccess = function (event) {
                var cursor = event.target.result;
                if (cursor && cursor.value && cursor.value.id) {

                    // Make sure we are not return FeatureLayer JSON data or a Phantom Graphic
                    if (cursor.value.id.indexOf(phantomGraphicPrefix) != -1) {
                        editsArray.push(cursor.value);

                    }
                    cursor.continue();
                }
                else {
                    callback(editsArray, "end");
                }
            }.bind(this);
            transaction.onerror = function (err) {
                callback(null, err);
            };
        }
        else {
            callback(null, "no db");
        }
    };

    /**
     * Internal method that returns an array of id's only
     * @param callback
     * @private
     */
    this._getPhantomGraphicsArraySimple = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");
        var editsArray = [];

        if (this._db !== null) {

            var phantomGraphicPrefix = this.PHANTOM_GRAPHIC_PREFIX;

            var transaction = this._db.transaction([objectStoreName])
                .objectStore(objectStoreName)
                .openCursor();

            transaction.onsuccess = function (event) {
                var cursor = event.target.result;
                if (cursor && cursor.value && cursor.value.id) {

                    // Make sure we are not return FeatureLayer JSON data or a Phantom Graphic
                    if (cursor.value.id.indexOf(phantomGraphicPrefix) != -1) {
                        editsArray.push(cursor.value.id);

                    }
                    cursor.continue();
                }
                else {
                    callback(editsArray, "end");
                }
            }.bind(this);
            transaction.onerror = function (err) {
                callback(null, err);
            };
        }
        else {
            callback(null, "no db");
        }
    };

    /**
     * Deletes an individual graphic from the phantom layer
     * @param id
     * @param callback callback(boolean, message)
     */
    this.deletePhantomGraphic = function (id, callback) {
        // NOTE: the implementation of the IndexedDB spec has a design fault with respect to
        // handling deletes. The result of a delete operation is always designated as undefined.
        // What this means is that there is no way to tell if an operation was successful or not.
        // And, it will always return 'true.'
        //
        // In order to get around this we have to verify if after the attempted deletion operation
        // if the record is or is not in the database. Kinda dumb, but that's how IndexedDB works.
        //http://stackoverflow.com/questions/17137879/is-there-a-way-to-get-information-on-deleted-record-when-calling-indexeddbs-obj

        var db = this._db;
        var deferred = null;
        var self = this;

        require(["dojo/Deferred"], function (Deferred) {
            deferred = new Deferred();

            // Step 1 - lets see if record exits. If it does then return callback.
            self.editExists(id).then(function (result) {
                    if (result.success) {
                        // Step 4 - Then we check to see if the record actually exists or not.
                        deferred.then(function (result) {

                                // IF the delete was successful, then the record should return 'false' because it doesn't exist.
                                self.editExists(id).then(function (results) {
                                        results.success == false ? callback(true) : callback(false);
                                    },
                                    function (err) {
                                        callback(true); //because we want this test to throw an error. That means item deleted.
                                    })
                            },
                            // There was a problem with the delete operation on the database
                            function (err) {
                                callback(false, err);
                            });

                        var objectStore = db.transaction([objectStoreName], "readwrite").objectStore(objectStoreName);

                        // Step 2 - go ahead and delete graphic
                        var objectStoreDeleteRequest = objectStore.delete(id);

                        // Step 3 - We know that the onsuccess will always fire unless something serious goes wrong.
                        // So we go ahead and resolve the deferred here.
                        objectStoreDeleteRequest.onsuccess = function () {
                            deferred.resolve(true);
                        };

                        objectStoreDeleteRequest.onerror = function (msg) {
                            deferred.reject({success: false, error: msg});
                        }
                    }
                },
                // If there is an error in editExists()
                function (err) {
                    callback(false);
                });
        });
    };

    /**
     * Removes some phantom graphics from database
     * @param callback boolean
     */
    this.resetLimitedPhantomGraphicsQueue = function (responseObject, callback) {

        if (Object.keys(responseObject).length > 0) {
            var db = this._db;

            var errors = 0;
            var tx = db.transaction([objectStoreName], "readwrite");
            var objectStore = tx.objectStore(objectStoreName);

            objectStore.onerror = function () {
                errors++;
                console.log("PHANTOM GRAPHIC ERROR")
            };

            tx.oncomplete = function () {
                errors == 0 ? callback(true) : callback(false);
            };

            for (var key in responseObject) {
                if (responseObject.hasOwnProperty(key)) {
                    var edit = responseObject[key];
                    var id = this.PHANTOM_GRAPHIC_PREFIX + this._PHANTOM_PREFIX_TOKEN + edit.id;
                    console.log("EDIT " + JSON.stringify(edit))

                    // CAUTION:
                    // TO-DO we do NOT match the edit.id with edit's objectId

                    if (edit.updateResults.length > 0) {
                        if (edit.updateResults[0].success) {
                            objectStore.delete(id);
                        }
                    }
                    if (edit.deleteResults.length > 0) {
                        if (edit.deleteResults[0].success) {
                            objectStore.delete(id);
                        }
                    }
                    if (edit.addResults.length > 0) {
                        if (edit.addResults[0].success) {
                            objectStore.delete(id);
                        }
                    }
                }
            }
            callback(true);

        }
        else {
            callback(true);
        }

    };


    /**
     * Removes all phantom graphics from database
     * @param callback boolean
     */
    this.resetPhantomGraphicsQueue = function (callback) {

        var db = this._db;

        // First we need to get the array of graphics that are stored in the database
        // so that we can cycle thru them.
        this._getPhantomGraphicsArraySimple(function (array) {
            if (array != []) {

                var errors = 0;
                var tx = db.transaction([objectStoreName], "readwrite");
                var objectStore = tx.objectStore(objectStoreName);

                objectStore.onerror = function () {
                    errors++;
                }

                tx.oncomplete = function () {
                    errors == 0 ? callback(true) : callback(false);
                }

                var length = array.length;
                for (var i = 0; i < length; i++) {
                    objectStore.delete(array[i]);
                }
            }
            else {
                callback(true);
            }
        });
    };

    /**
     * Returns all the edits recursively via the callback
     * @param callback {value, message}
     */
    this.getAllEdits = function (callback) {

        console.assert(this._db !== null, "indexeddb not initialized");

        if (this._db !== null) {

            var fLayerJSONId = this.FEATURE_LAYER_JSON_ID;
            var phantomGraphicPrefix = this.PHANTOM_GRAPHIC_PREFIX;

            var transaction = this._db.transaction([objectStoreName])
                .objectStore(objectStoreName)
                .openCursor();

            transaction.onsuccess = function (event) {
                var cursor = event.target.result;
                if (cursor && cursor.hasOwnProperty("value") && cursor.value.hasOwnProperty("id")) {

                    // Make sure we are not return FeatureLayer JSON data or a Phantom Graphic
                    if (cursor.value.id !== fLayerJSONId && cursor.value.id.indexOf(phantomGraphicPrefix) == -1) {
                        callback(cursor.value, null);
                    }
                    cursor.continue();
                }
                else {
                    callback(null, "end");
                }
            }.bind(this);
            transaction.onerror = function (err) {
                callback(null, err);
            };
        }
        else {
            callback(null, "no db");
        }
    };

    /**
     * Returns all the edits as a single Array via the callback
     * @param callback {value, message}
     */
    this.getAllEditsArray = function (callback) {

        console.assert(this._db !== null, "indexeddb not initialized");
        var editsArray = [];

        if (this._db !== null) {

            var fLayerJSONId = this.FEATURE_LAYER_JSON_ID;
            var phantomGraphicPrefix = this.PHANTOM_GRAPHIC_PREFIX;

            var transaction = this._db.transaction([objectStoreName])
                .objectStore(objectStoreName)
                .openCursor();

            transaction.onsuccess = function (event) {
                var cursor = event.target.result;
                if (cursor && cursor.value && cursor.value.id) {

                    // Make sure we are not return FeatureLayer JSON data or a Phantom Graphic
                    if (cursor.value.id !== fLayerJSONId && cursor.value.id.indexOf(phantomGraphicPrefix) == -1) {
                        editsArray.push(cursor.value);

                    }
                    cursor.continue();
                }
                else {
                    callback(editsArray, "end");
                }
            }.bind(this);
            transaction.onerror = function (err) {
                callback(null, err);
            };
        }
        else {
            callback(null, "no db");
        }
    };

    /**
     * Update an edit already exists in the database
     * @param operation add, update or delete
     * @param layer the URL of the feature layer
     * @param graphic esri/graphic. The method will serialize to JSON
     * @param callback {true, edit} or {false, error}
     */
    this.updateExistingEdit = function (operation, layer, graphic, callback) {

        console.assert(this._db !== null, "indexeddb not initialized");

        var objectStore = this._db.transaction([objectStoreName], "readwrite").objectStore(objectStoreName);

        //Let's get the entry associated with the graphic
        var objectStoreGraphicRequest = objectStore.get(graphic.attributes.objectid);
        objectStoreGraphicRequest.onsuccess = function () {

            //Grab the data object returned as a result
            var data = objectStoreGraphicRequest.result;

            //Create a new update object
            var update = {
                id: layer + "/" + graphic.attributes.objectid,
                operation: operation,
                layer: layer,
                graphic: graphic.toJson()
            };

            // Insert the update into the database
            var updateGraphicRequest = objectStore.put(update);

            updateGraphicRequest.onsuccess = function () {
                callback(true);
            }

            updateGraphicRequest.onerror = function (err) {
                callback(false, err);
            };
        }
    };

    /**
     * Delete a pending edit's record from the database.
     * IMPORTANT: Be aware of false negatives. See Step 4 in this function.
     *
     * @param layerUrl
     * @param graphic Graphic
     * @param callback {boolean, error}
     */
    this.delete = function (layerUrl, graphic, callback) {

        // NOTE: the implementation of the IndexedDB spec has a design fault with respect to
        // handling deletes. The result of a delete operation is always designated as undefined.
        // What this means is that there is no way to tell if an operation was successful or not.
        // And, it will always return 'true.'
        //
        // In order to get around this we have to verify if after the attempted deletion operation
        // if the record is or is not in the database. Kinda dumb, but that's how IndexedDB works.
        //http://stackoverflow.com/questions/17137879/is-there-a-way-to-get-information-on-deleted-record-when-calling-indexeddbs-obj

        var db = this._db;
        var deferred = null;
        var self = this;

        var id = layerUrl + "/" + graphic.attributes.objectid;

        require(["dojo/Deferred"], function (Deferred) {
            deferred = new Deferred();

            // Step 1 - lets see if record exits. If it does then return callback.
            self.editExists(id).then(function (result) {
                    if (result.success) {
                        // Step 4 - Then we check to see if the record actually exists or not.
                        deferred.then(function (result) {

                                // IF the delete was successful, then the record should return 'false' because it doesn't exist.
                                self.editExists(id).then(function (results) {
                                        results.success == false ? callback(true) : callback(false);
                                    },
                                    function (err) {
                                        callback(true); //because we want this test to throw an error. That means item deleted.
                                    })
                            },
                            // There was a problem with the delete operation on the database
                            function (err) {
                                callback(false, err);
                            });

                        var objectStore = db.transaction([objectStoreName], "readwrite").objectStore(objectStoreName);

                        // Step 2 - go ahead and delete graphic
                        var objectStoreDeleteRequest = objectStore.delete(id);

                        // Step 3 - We know that the onsuccess will always fire unless something serious goes wrong.
                        // So we go ahead and resolve the deferred here.
                        objectStoreDeleteRequest.onsuccess = function () {
                            deferred.resolve(true);
                        };

                        objectStoreDeleteRequest.onerror = function (msg) {
                            deferred.reject({success: false, error: msg});
                        }
                    }
                },
                // If there is an error in editExists()
                function (err) {
                    callback(false);
                });
        });
    };

    /**
     * Full database reset.
     * CAUTION! If some edits weren't successfully sent, then their record
     * will still exist in the database. If you use this function you
     * will also delete those records.
     * @param callback boolean
     */
    this.resetEditsQueue = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var request = this._db.transaction([objectStoreName], "readwrite")
            .objectStore(objectStoreName)
            .clear();
        request.onsuccess = function (event) {
            setTimeout(function () {
                callback(true);
            }, 0);
        };
        request.onerror = function (err) {
            callback(false, err);
        };
    };

    this.pendingEditsCount = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var count = 0;
        var id = this.FEATURE_LAYER_JSON_ID;
        var phantomGraphicPrefix = this.PHANTOM_GRAPHIC_PREFIX;

        var transaction = this._db.transaction([objectStoreName], "readwrite")
        var objectStore = transaction.objectStore(objectStoreName);
        objectStore.openCursor().onsuccess = function (evt) {
            var cursor = evt.target.result;

            // IMPORTANT:
            // Remember that we have feature layer JSON and Phantom Graphics in the same database
            if (cursor && cursor.value && cursor.value.id && cursor.value.id.indexOf(phantomGraphicPrefix) == -1) {
                if (cursor.value.id !== id) {
                    count++;
                }
                cursor.continue();
            }
            else {
                callback(count);
            }
        };
    };

    /**
     * Verify is an edit already exists in the database. Checks the objectId and layerId.
     * @param id
     * @returns {deferred} {success: boolean, error: message}
     * @private
     */
    this.editExists = function (id) {

        var db = this._db;
        var deferred = null;

        require(["dojo/Deferred"], function (Deferred) {
            deferred = new Deferred();

            var objectStore = db.transaction([objectStoreName], "readwrite").objectStore(objectStoreName);

            //Get the entry associated with the graphic
            var objectStoreGraphicRequest = objectStore.get(id);

            objectStoreGraphicRequest.onsuccess = function () {
                var graphic = objectStoreGraphicRequest.result;
                if (graphic && (graphic.id == id)) {
                    deferred.resolve({success: true, error: null});
                }
                else {
                    deferred.reject({success: false, error: "Layer id is not a match."});
                }
            };

            objectStoreGraphicRequest.onerror = function (msg) {
                deferred.reject({success: false, error: msg});
            }
        });

        //We return a deferred object so that when calling this function you can chain it with a then() statement.
        return deferred;
    };

    /**
     * Returns the approximate size of the database in bytes
     * IMPORTANT: Currently requires all data be serialized!
     * @param callback  {usage, error} Whereas, the usage Object is {sizeBytes: number, editCount: number}
     */
    this.getUsage = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var id = this.FEATURE_LAYER_JSON_ID;
        var phantomGraphicPrefix = this.PHANTOM_GRAPHIC_PREFIX;

        var usage = {sizeBytes: 0, editCount: 0};

        var transaction = this._db.transaction([objectStoreName])
            .objectStore(objectStoreName)
            .openCursor();

        console.log("dumping keys");

        transaction.onsuccess = function (event) {
            var cursor = event.target.result;
            if (cursor && cursor.value && cursor.value.id) {
                var storedObject = cursor.value;
                var json = JSON.stringify(storedObject);
                usage.sizeBytes += json.length;

                if (cursor.value.id.indexOf(phantomGraphicPrefix) == -1 && cursor.value.id !== id) {
                    usage.editCount += 1;
                }

                cursor.continue();
            }
            else {
                callback(usage, null);
            }
        };
        transaction.onerror = function (err) {
            callback(null, err);
        };
    };

    // internal methods

    /**
     * Save space in the database...don't need to store the entire Graphic object just its public properties!
     * @param graphic
     * @returns {*}
     * @private
     */
    this._serialize = function (graphic) {
        // see http://resources.arcgis.com/en/help/arcgis-rest-api/index.html#/Apply_Edits_Feature_Service_Layer/02r3000000r6000000/
        // use graphic's built-in serializing method
        var json = graphic.toJson();
        var jsonClean =
        {
            attributes: json.attributes,
            geometry: json.geometry,
            infoTemplate: json.infoTemplate,
            symbol: json.symbol
        };
        return JSON.stringify(jsonClean);
    };

    this._deserialize = function (json) {
        var graphic;

        require(["esri/graphic"], function (Graphic) {
            graphic = new Graphic(JSON.parse(json));
        });

        return graphic;
    };

    this.init = function (callback) {
        console.log("init editsStore.js");

        var request = indexedDB.open(dbName, 11);
        callback = callback || function (success) {
            console.log("EditsStore::init() success:", success);
        }.bind(this);

        request.onerror = function (event) {
            console.log("indexedDB error: " + event.target.errorCode);
            callback(false, event.target.errorCode);
        }.bind(this);

        request.onupgradeneeded = function (event) {
            var db = event.target.result;

            if (db.objectStoreNames.contains(objectStoreName)) {
                db.deleteObjectStore(objectStoreName);
            }

            var objectStore = db.createObjectStore(objectStoreName, {keyPath: "id"});
            objectStore.createIndex(dbIndex, dbIndex, {unique: false});
        }.bind(this);

        request.onsuccess = function (event) {
            this._db = event.target.result;
            console.log("database opened successfully");
            callback(true);
        }.bind(this);
    };

    ///
    /// DEPRECATED
    ///

    /**
     * Deprecated @ v2.5. Use pendingEditsCount() instead.
     */
    this.hasPendingEdits = function () {
        return "DEPRECATED at v2.5!";
    };

    /**
     * Deprecated @ v2.5. Use public function editExists() instead.
     */
    this._isEditDuplicated = function (newEdit, edits) {
        return "DEPRECATED at v2.5!";
    };

    /**
     * Deprecated @ v2.5. 
     * @returns {string}
     */
    this.retrieveEditsQueue = function(){
        return "DEPRECATED at v2.5!";
    };

    /**
     * Deprecated @ v2.5.
     * @returns {string}
     */
    this.getEditsStoreSizeBytes = function(){
        return "DEPRECATED at v2.5!";
    };

    /**
     * Deprecated @ v2.5.
     * @returns {string}
     */
    this.getLocalStorageSizeBytes = function(){
        return "DEPRECATED at v2.5!";
    };
};



/*global IDBKeyRange,indexedDB */

"use strict";
O.esri.Edit.AttachmentsStore = function () {
    this._db = null;

    var DB_NAME = "attachments_store";
    var OBJECT_STORE_NAME = "attachments";

    this.isSupported = function () {
        if (!window.indexedDB) {
            return false;
        }
        return true;
    };

    this.store = function (featureLayerUrl, attachmentId, objectId, attachmentFile, callback) {
        try {
            // first of all, read file content
            this._readFile(attachmentFile, function (fileContent) {
                // now, store it in the db
                var newAttachment =
                {
                    id: attachmentId,
                    objectId: objectId,
                    featureId: featureLayerUrl + "/" + objectId,
                    contentType: attachmentFile.type,
                    name: attachmentFile.name,
                    size: attachmentFile.size,
                    url: this._createLocalURL(attachmentFile),
                    content: fileContent
                };

                var transaction = this._db.transaction([OBJECT_STORE_NAME], "readwrite");

                transaction.oncomplete = function (event) {
                    callback(true, newAttachment);
                };

                transaction.onerror = function (event) {
                    callback(false, event.target.error.message);
                };

                var objectStore = transaction.objectStore(OBJECT_STORE_NAME);
                var request = objectStore.put(newAttachment);
                request.onsuccess = function (event) {
                    //console.log("item added to db " + event.target.result);
                };

            }.bind(this));
        }
        catch (err) {
            console.log("AttachmentsStore: " + err.stack);
            callback(false, err.stack);
        }
    };

    this.retrieve = function (attachmentId, callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var objectStore = this._db.transaction([OBJECT_STORE_NAME]).objectStore(OBJECT_STORE_NAME);
        var request = objectStore.get(attachmentId);
        request.onsuccess = function (event) {
            var result = event.target.result;
            if (!result) {
                callback(false, "not found");
            }
            else {
                callback(true, result);
            }
        };
        request.onerror = function (err) {
            console.log(err);
            callback(false, err);
        };
    };

    this.getAttachmentsByFeatureId = function (featureLayerUrl, objectId, callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var featureId = featureLayerUrl + "/" + objectId;
        var attachments = [];

        var objectStore = this._db.transaction([OBJECT_STORE_NAME]).objectStore(OBJECT_STORE_NAME);
        var index = objectStore.index("featureId");
        var keyRange = IDBKeyRange.only(featureId);
        index.openCursor(keyRange).onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) {
                attachments.push(cursor.value);
                cursor.continue();
            }
            else {
                callback(attachments);
            }
        };
    };

    this.getAttachmentsByFeatureLayer = function (featureLayerUrl, callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var attachments = [];

        var objectStore = this._db.transaction([OBJECT_STORE_NAME]).objectStore(OBJECT_STORE_NAME);
        var index = objectStore.index("featureId");
        var keyRange = IDBKeyRange.bound(featureLayerUrl + "/", featureLayerUrl + "/A");
        index.openCursor(keyRange).onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) {
                attachments.push(cursor.value);
                cursor.continue();
            }
            else {
                callback(attachments);
            }
        };
    };

    this.getAllAttachments = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var attachments = [];

        var objectStore = this._db.transaction([OBJECT_STORE_NAME]).objectStore(OBJECT_STORE_NAME);
        objectStore.openCursor().onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) {
                attachments.push(cursor.value);
                cursor.continue();
            }
            else {
                callback(attachments);
            }
        };
    };

    this.deleteAttachmentsByFeatureId = function (featureLayerUrl, objectId, callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var featureId = featureLayerUrl + "/" + objectId;

        var objectStore = this._db.transaction([OBJECT_STORE_NAME], "readwrite").objectStore(OBJECT_STORE_NAME);
        var index = objectStore.index("featureId");
        var keyRange = IDBKeyRange.only(featureId);
        var deletedCount = 0;
        index.openCursor(keyRange).onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) {
                var attachment = cursor.value;
                this._revokeLocalURL(attachment);
                objectStore.delete(cursor.primaryKey);
                deletedCount++;
                cursor.continue();
            }
            else {
                setTimeout(function () {
                    callback(deletedCount);
                }, 0);
            }
        }.bind(this);
    };

    this.delete = function (attachmentId, callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        // before deleting an attachment we must revoke the blob URL that it contains
        // in order to free memory in the browser
        this.retrieve(attachmentId, function (success, attachment) {
            if (!success) {
                callback(false, "attachment " + attachmentId + " not found");
                return;
            }

            this._revokeLocalURL(attachment);

            var request = this._db.transaction([OBJECT_STORE_NAME], "readwrite")
                .objectStore(OBJECT_STORE_NAME)
                .delete(attachmentId);
            request.onsuccess = function (event) {
                setTimeout(function () {
                    callback(true);
                }, 0);
            };
            request.onerror = function (err) {
                callback(false, err);
            };
        }.bind(this));
    };

    this.deleteAll = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        this.getAllAttachments(function (attachments) {
            attachments.forEach(function (attachment) {
                this._revokeLocalURL(attachment);
            }, this);

            var request = this._db.transaction([OBJECT_STORE_NAME], "readwrite")
                .objectStore(OBJECT_STORE_NAME)
                .clear();
            request.onsuccess = function (event) {
                setTimeout(function () {
                    callback(true);
                }, 0);
            };
            request.onerror = function (err) {
                callback(false, err);
            };
        }.bind(this));
    };

    this.replaceFeatureId = function (featureLayerUrl, oldId, newId, callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var featureId = featureLayerUrl + "/" + oldId;

        var objectStore = this._db.transaction([OBJECT_STORE_NAME], "readwrite").objectStore(OBJECT_STORE_NAME);
        var index = objectStore.index("featureId");
        var keyRange = IDBKeyRange.only(featureId);
        var replacedCount = 0;
        index.openCursor(keyRange).onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) {
                var newFeatureId = featureLayerUrl + "/" + newId;
                var updated = cursor.value;
                updated.featureId = newFeatureId;
                updated.objectId = newId;
                objectStore.put(updated);
                replacedCount++;
                cursor.continue();
            }
            else {
                // allow time for all changes to persist...
                setTimeout(function () {
                    callback(replacedCount);
                }, 1);
            }
        };
    };

    this.getUsage = function (callback) {
        console.assert(this._db !== null, "indexeddb not initialized");

        var usage = {sizeBytes: 0, attachmentCount: 0};

        var transaction = this._db.transaction([OBJECT_STORE_NAME])
            .objectStore(OBJECT_STORE_NAME)
            .openCursor();

        console.log("dumping keys");

        transaction.onsuccess = function (event) {
            var cursor = event.target.result;
            if (cursor) {
                console.log(cursor.value.id, cursor.value.featureId, cursor.value.objectId);
                var storedObject = cursor.value;
                var json = JSON.stringify(storedObject);
                usage.sizeBytes += json.length;
                usage.attachmentCount += 1;
                cursor.continue();
            }
            else {
                callback(usage, null);
            }
        }.bind(this);
        transaction.onerror = function (err) {
            callback(null, err);
        };
    };

    // internal methods

    this._readFile = function (attachmentFile, callback) {
        var reader = new FileReader();
        reader.onload = function (evt) {
            callback(evt.target.result);
        };
        reader.readAsBinaryString(attachmentFile);
    };

    this._createLocalURL = function (attachmentFile) {
        return window.URL.createObjectURL(attachmentFile);
    };

    this._revokeLocalURL = function (attachment) {
        window.URL.revokeObjectURL(attachment.url);
    };

    this.init = function (callback) {
        console.log("init AttachmentStore");

        var request = indexedDB.open(DB_NAME, 11);
        callback = callback || function (success) {
            console.log("AttachmentsStore::init() success:", success);
        }.bind(this);

        request.onerror = function (event) {
            console.log("indexedDB error: " + event.target.errorCode);
            callback(false, event.target.errorCode);
        }.bind(this);

        request.onupgradeneeded = function (event) {
            var db = event.target.result;

            if (db.objectStoreNames.contains(OBJECT_STORE_NAME)) {
                db.deleteObjectStore(OBJECT_STORE_NAME);
            }

            var objectStore = db.createObjectStore(OBJECT_STORE_NAME, {keyPath: "id"});
            objectStore.createIndex("featureId", "featureId", {unique: false});
        }.bind(this);

        request.onsuccess = function (event) {
            this._db = event.target.result;
            console.log("database opened successfully");
            callback(true);
        }.bind(this);
    };
};

