'use strict';

import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Point from '../ThirdParty/Point.js';
import Resource from "../Core/Resource.js";

var UNKNOWN_FEATURE = 0;
var POINT_FEATURE = 1;
var LINESTRING_FEATURE = 2;
var POLYGON_FEATURE = 3; // feature.type == 3 for polygon features

function VectorStyle(resource) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(resource)) {
        throw new DeveloperError("style resource is needed.");
    }
    //>>includeEnd('debug');

    this._styleLayers = undefined;
    this._version = undefined;
    this._sprites = undefined;
    this._glyphs = undefined;
    this._backgroundColor = "black";

    this._loadJsonStyle(resource);
}

VectorStyle.prototype._loadJsonStyle = function(resource) {
    var res = resource;
    var styleLayers = new Object();
    this._styleLayers = styleLayers;
    var that = this;

    resource.fetchJson().then(function(style) {
        // var indexUrl = res.getDerivedResource({
        //     url: '' + style.sprite + ".json"
        // }).url

        // var imageUrl = res.getDerivedResource({
        //     url: '/' + style.sprite + ".png"
        // }).url
        var indexUrl = style.sprite + ".json"
        var imageUrl = style.sprite + ".png"
        that._loadSprites(indexUrl, imageUrl);

        //tiles layers must be ordered by the style order
        //cache style information into variable for use
        for (var i = 0; i < Object.keys(style.layers).length; i++) {
            var layer = style.layers[i]["source-layer"];
            //if (LAYERS.indexOf(layer) < 0) continue;
            styleLayers[style.layers[i]["id"]] = style.layers[i];
        }
        return true;
    }).otherwise(function(error) {
        console.log("style error:" + error);
        return Cesium.when.reject("style error");
    });
}

VectorStyle.prototype.drawTile = function(canvas, tile, nativeTile, requestedTile) {
    var layers = Object.keys(tile.layers);
    var styles = Object.keys(this._styleLayers);
    var context = canvas.getContext("2d");
    //loop over styles (to get correct order of layers)
    for (var l = 0; l < styles.length; l++) {
        var jStyle = this._styleLayers[styles[l]];

        if (jStyle["type"] === "background") {
            if ("paint" in jStyle && "background-color" in jStyle.paint) {
                this._backgroundColor = jStyle.paint["background-color"];
            }
        }
        //context.fillRect(0,0,256,256);

        canvas.style.background = this._backgroundColor;
        context.fillStyle = this._backgroundColor;

        //context.stroke();

        if ("layout" in jStyle && "visibility" in jStyle.layout && jStyle.layout.visibility === "none") {
            context.fillRect(0, 0, 256, 256); 
            continue;
        }

        //current style not in layers
        if (!(jStyle["source-layer"] in tile.layers)) continue;
        //get layer based on style
        var layer = tile.layers[jStyle["source-layer"]];

        if (!defined(layer)) {
            return canvas; // return blank canvas for blank tile
        }

        var extentFactor = canvas.width / layer.extent; // Vector tile works with extent [0, 4095], but canvas is only [0,255]

        //if styles' specified zoom levels are not within current zoom, move to next style layer
        if ("minzoom" in jStyle && nativeTile.level < parseInt(jStyle.minzoom)) { continue };
        if ("maxzoom" in jStyle && nativeTile.level >= parseInt(jStyle.maxzoom)) { continue; }

        var textLabel = "";
        // Features
        //loop through each feature within the layer
        for (var i = 0; i < layer.length; i++) {
            //context.strokeStyle = "black";
            //context.fillStyle = "black";
            context.lineWidth = 1;
            canvas.style.background = this._backgroundColor;
            context.fillStyle = this._backgroundColor;
            //context.strokeStyle = this._backgroundColor;


            var feature = layer.feature(i);

            //if the current style has a 'filter', check it to see if it matches the current feature's property
            if (jStyle.filter !== undefined) {
                var prop = feature.properties[jStyle.filter[1]];
                if (prop !== undefined) {
                    var val = feature.properties[jStyle.filter[1]];
                    if (val != jStyle.filter[2]) continue;
                }
            }

            //if the current feature's specified zoom is not within the current zoom, move to next feature
            if ("_minzoom" in feature.properties && nativeTile.level < parseInt(feature.properties._minzoom)) { continue };
            if ("_maxzoom" in feature.properties && nativeTile.level >= parseInt(feature.properties._maxzoom)) { continue; }

            //only process known feature types
            if (feature.type > UNKNOWN_FEATURE) {
                var coordinates = getCoordinates(nativeTile, requestedTile, layer, feature);
                if (!defined(coordinates)) continue;
                if (feature.type === POLYGON_FEATURE) {
                    drawPolygons(context, jStyle, extentFactor, coordinates);
                } else if (feature.type === POINT_FEATURE) {
                    drawPoints(context, jStyle, extentFactor, coordinates, feature.properties, this._sprites);
                } else if (feature.type === LINESTRING_FEATURE) {
                    drawLines(context, jStyle, extentFactor, coordinates);
                } else {
                    console.log("***NOT POLYGON***");
                    console.log(
                        "Unexpected geometry type: " +
                        feature.type +
                        " in region map on tile " +
                        [requestedTile.level, requestedTile.x, requestedTile.y].join("/")
                    );
                }
            }
        }
    }

};

// Use x,y,level vector tile to produce imagery for newX,newY,newLevel
function overzoomGeometry(rings, nativeTile, newExtent, newTile) {
    var diffZ = newTile.level - nativeTile.level;
    if (diffZ === 0) {
        return rings;
    } else {
        var newRings = [];
        // (offsetX, offsetY) is the (0,0) of the new tile
        var offsetX = newExtent * (newTile.x - (nativeTile.x << diffZ));
        var offsetY = newExtent * (newTile.y - (nativeTile.y << diffZ));
        for (var i = 0; i < rings.length; i++) {
            var ring = [];
            for (var i2 = 0; i2 < rings[i].length; i2++) {
                ring.push(rings[i][i2].sub(new Point(offsetX, offsetY)));
            }
            newRings.push(ring);
        }
        return newRings;
    }
}

function getCoordinates(nativeTile, requestedTile, layer, feature) {
    var coordinates;
    if (nativeTile.level !== requestedTile.level) {
        // Overzoom feature
        var bbox = feature.bbox(); // [w, s, e, n] bounding box
        var featureRect = new BoundingRectangle(
            bbox[0],
            bbox[1],
            bbox[2] - bbox[0],
            bbox[3] - bbox[1]
        );
        var levelDelta = requestedTile.level - nativeTile.level;
        var size = layer.extent >> levelDelta;
        if (size < 16) {
            // Tile has less less detail than 16x16
            throw new DeveloperError(("maxLevelError"));
        }
        var x1 = size * (requestedTile.x - (nativeTile.x << levelDelta)); //
        var y1 = size * (requestedTile.y - (nativeTile.y << levelDelta));
        var tileRect = new BoundingRectangle(x1, y1, size, size);
        extentFactor = canvas.width / size;
        if (
            BoundingRectangle.intersect(featureRect, tileRect) ===
            Intersect.OUTSIDE
        ) {
            return undefined;
        }
        coordinates = overzoomGeometry(
            feature.loadGeometry(),
            nativeTile,
            size,
            requestedTile
        );
    } else {
        coordinates = feature.loadGeometry();
    }
    return coordinates;
}

function drawPolygons(context, jStyle, extentFactor, coordinates) {
    context.translate(0.5, 0.5);
    // context.lineWidth = 1;
    // context.fillStyle = "#000000";
    // context.strokeStyle = "#000000";
    if ("paint" in jStyle && "fill-color" in jStyle.paint) context.fillStyle = jStyle.paint["fill-color"];
    if ("paint" in jStyle && "fill-outline-color" in jStyle.paint) { context.strokeStyle = jStyle.paint["fill-outline-color"] } else { context.strokeStyle = context.fillStyle };

    // Polygon rings
    context.beginPath();
    for (var i2 = 0; i2 < coordinates.length; i2++) {
        var pos = coordinates[i2][0];
        context.moveTo(pos.x * extentFactor, pos.y * extentFactor);

        // Polygon ring points
        for (var j = 1; j < coordinates[i2].length; j++) {
            pos = coordinates[i2][j];
            context.lineTo(pos.x * extentFactor, pos.y * extentFactor);
        }
    }
    context.closePath();
    context.fill();
    context.stroke();
    context.translate(-0.5, -0.5);
}

function drawPoints(context, jStyle, extentFactor, coordinates, properties, sprites) {
    context.translate(0.5, 0.5);
    var font = "Arial Unicode MS Regular";
    var fontSize = "16";
    var anchor = "";
    //if ("layout" in jStyle && "symbol-placement" in jStyle.layout && jStyle.layout["symbol-placement"] === "line") return;

    if ("layout" in jStyle && "text-size" in jStyle.layout) fontSize = jStyle.layout["text-size"];
    if ("layout" in jStyle && "text-font" in jStyle.layout) font = fontSize + "px " + jStyle.layout["text-font"][0];
    if ("layout" in jStyle && "text-anchor" in jStyle.layout) anchor = jStyle.layout["text-anchor"];
    if ("paint" in jStyle && "text-color" in jStyle.paint) context.fillStyle = jStyle.paint["text-color"];
    if ("paint" in jStyle && "text-color" in jStyle.paint) context.strokeStyle = jStyle.paint["text-color"];
    context.font = font * extentFactor;
    context.textAlign = "center";
    context.textBaseline = "middle";

    var xOff = 0;
    var yOff = 0;

    //loop through the coordinates array
    for (var i2 = 0; i2 < coordinates.length; i2++) {
        var pos = coordinates[i2][0];

        var xPos = pos.x * extentFactor;
        var yPos = pos.y * extentFactor;

        //process icons
        if ("filter" in jStyle && jStyle.filter[1] === "_symbol")

            if ("filter" in jStyle && jStyle.filter[1] === "_symbol" && "layout" in jStyle && "icon-image" in jStyle.layout) {
                var imageName = jStyle.layout["icon-image"];
                var imageData = sprites[imageName];
                //draw off-screen first
                var canvas = document.createElement("CANVAS");
                const offCtx = canvas.cloneNode().getContext('2d'); // an offscreen canvas
                offCtx.putImageData(imageData, 0, 0);
                //draw on main canvas (putimage will lose alpha)
                context.drawImage(offCtx.canvas, xPos - offCtx.canvas.width / 2 * extentFactor, yPos - offCtx.canvas.height / 2 * extentFactor);
            }

        //process icon labels
        if ("filter" in jStyle && jStyle.filter[1] === "_label_class1" && "_name1" in properties) {
            var t = context.measureText(properties._name1);
            var tt = {};
            tt.y1 = t.actualBoundingBoxAscent + yPos;
            tt.y2 = t.actualBoundingBoxDescent + yPos;
            tt.x1 = t.actualBoundingBoxLeft + xPos;
            tt.x2 = t.actualBoundingBoxRight + xPos;
            context.fillText(properties._name1, xPos, yPos);
        } else if ("_name" in properties) {
            //TODO
            //process other labels
        }
    }
    context.translate(-0.5, -0.5);
}

function drawLines(context, jStyle, extentFactor, coordinates) {
    //context.lineWidth = 1;
    context.lineJoin = "miter";
    context.lineCap = "butt";
    //context.strokeStyle = "#ffffff";
    context.translate(0.5, 0.5);
    if ("layout" in jStyle && "line-join" in jStyle.layout) context.lineJoin = jStyle.layout["line-join"];
    if ("layout" in jStyle && "line-cap" in jStyle.layout) context.lineCap = jStyle.layout["line-cap"];
    if ("paint" in jStyle && "line-width" in jStyle.paint) context.lineWidth = parseFloat(jStyle.paint["line-width"]) / 2;
    if ("paint" in jStyle && "line-color" in jStyle.paint) context.strokeStyle = jStyle.paint["line-color"];

    context.beginPath();
    for (var i2 = 0; i2 < coordinates.length; i2++) {
        var pos = coordinates[i2][0];
        context.moveTo(pos.x * extentFactor, pos.y * extentFactor);

        // lines
        for (var j = 1; j < coordinates[i2].length; j++) {
            pos = coordinates[i2][j];
            context.lineTo(pos.x * extentFactor, pos.y * extentFactor);
        }
    }
    context.stroke();
    context.translate(-0.5, -0.5);
    //context.fill();
}

VectorStyle.prototype._loadSprites = function(spriteIndexUrl, spriteImgUrl) {
    //icons are loaded from a single png file
    //locations specified in a json file
    var resource = Resource.createIfNeeded(spriteIndexUrl);
    var spriteIndexResource = resource.getDerivedResource({
        url: spriteIndexUrl
    });

    var sprites = new Object();
    this._sprites = sprites;
    var image = new Image();
    image.crossOrigin = "Anonymous";
    image.onload = function() {
        var spriteCanvas = document.createElement("canvas");
        spriteCanvas.width = image.width;
        spriteCanvas.height = image.height;
        var spriteCtx = spriteCanvas.getContext("2d");
        spriteCtx.fillStyle = "red";
        spriteCtx.globalAlpha = 1.0;
        //spriteCtx.fillRect(0, 0, image.width, image.height);
        spriteCtx.clearRect(0, 0, image.width, image.height);
        spriteCtx.drawImage(image, 0, 0, image.width, image.height);

        spriteIndexResource.fetchJson().then(function(spriteIndex) {
            //cache image data for later use
            for (var i = 0; i < Object.keys(spriteIndex).length; i++) {
                var k = Object.keys(spriteIndex)[i];
                var v = Object.values(spriteIndex)[i];
                var data = spriteCtx.getImageData(v.x, v.y, v.width, v.height);
                sprites[k] = data;
            }
        });

    }
    image.src = spriteImgUrl;
}

export default VectorStyle;