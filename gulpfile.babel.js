import got from "got";
import gulp from "gulp";
import clean from "gulp-clean";
import jest from "gulp-jest";
import tslint from "gulp-tslint";
import { createProject } from "gulp-typescript";
import sourcemaps from "gulp-sourcemaps";
import { parseString, processors } from "xml2js";
import merge from "merge2";
import jestConfig from "./jest.config";
import codecov from 'gulp-codecov';
import { spawn } from 'child_process';
import tagVersion from 'gulp-tag-version';
import bump from 'gulp-bump';
import git from 'gulp-git';
import push from 'gulp-git-push';

import fs from "fs";

var tsProject = createProject("tsconfig.json");

const fixRepoDownloadOptions = {
    baseUrl: 'https://raw.githubusercontent.com/FIXTradingCommunity/orchestrations/master/FIX%20Standard/',
    retry: 3
}

const repoFiles = {
    fix42: 'FixRepository42.xml',
    fix44: 'FixRepository44.xml',
    fix50: 'FixRepository50SP2.xml'
}

gulp.task("tslint", () =>
    tsProject.src()
        .pipe(tslint({ formatter: "verbose" }))
        .pipe(tslint.report())
);

gulp.task("build", () => {
    const dest = "build";
    const tsResult = tsProject.src()
        .pipe(sourcemaps.init())
        .pipe(tsProject());

    return merge ([
        tsResult.js
            .pipe(sourcemaps.write('./'))
            .pipe(gulp.dest(dest)),
        tsResult.dts
            .pipe(gulp.dest(dest))]);
});

gulp.task("install", () => {
    const promises = Object.entries(repoFiles).map(([key, value]) =>
        got(value, fixRepoDownloadOptions).then(response => {
            parse(response.body, json => fs.writeFileSync(`resources/${key}.json`, JSON.stringify(json, null, 2)));
        })
    );

    return new Promise(done => {
        !fs.existsSync('resources') && fs.mkdir('resources', () => {
            done();
        });
        done();
    }).then (() => Promise.all(promises));
});

gulp.task('clean', () => {
    return gulp.src(['build/', 'resources/'], {allowEmpty: true})
        .pipe(clean());
});

gulp.task('test', () => {
    process.env.NODE_ENV = 'test';
    return gulp.src('__tests__').pipe(jest(jestConfig))
});

gulp.task('coverage', () => {
    return gulp.src('./coverage/lcov.info').pipe(codecov());
});

gulp.task('publish', done => {
    spawn('npm', ['publish'], { stdio: 'inherit', shell: true }).on('close', done);
});

gulp.task('tag', () =>
    gulp.src(['./package.json'])
        .pipe(tagVersion())
        .pipe(push({
            repository: 'origin',
            refspec: 'HEAD'
        }))
);

gulp.task('bump', () =>
    gulp.src('./package.json')
        .pipe(bump({ type: 'minor' }))
        .pipe(gulp.dest('./'))
        .pipe(git.commit('bump version'))
        .pipe(push({
            repository: 'origin',
            refspec: 'HEAD'
        }))
);

gulp.task('default', gulp.series('clean', 'install', 'tslint', 'build', 'test', 'coverage'));

gulp.task('release', gulp.series('clean', 'install', 'tslint', 'build', 'test', 'tag', 'publish', 'bump'));

function parse(content, callback) {
    parseString(content, { tagNameProcessors: [ processors.stripPrefix ], normalize: true, preserveChildrenOrder: true, explicitChildren: true }, (error, xml) => {
        const repo = xml["repository"];
        const categories = parseCategory(repo);
        const codeSets = parseCodeSets(repo);
        const components = parseComponents(repo);
        const dataTypes = parseDataType(repo);
        const fields = parseFields(repo);
        const messages = parseMessages(repo);
        const sections = parseSections(repo);
        const groups = parseGroups(repo);

        const result = {
            categories,
            codeSets,
            components,
            dataTypes,
            fields,
            groups,
            messages,
            sections
        }
        callback(result);
    });
}

function parseCategory(repo) {
    if (!repo["categories"]) {
        return undefined;
    }
    return repo["categories"][0]["category"].reduce((map, category) => {
        map[category.$.id] = {
            ...category.$
        }
        return map;
    }, {});
}

function parseSections(repo) {
    if (!repo["sections"]) {
        return undefined;
    }
    return repo["sections"][0]["section"].map(section => { return {
            ...section.$,
            displayOrder: parseInt(section.$.displayOrder),
            documentation: parseDocument(section.annotation[0].documentation)
        }})
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .reduce((map, section) => {
            map[section.id] = section;
            return map;
        }, {});
}

function parseDataType(repo) {
    return repo["datatypes"][0]["datatype"].reduce((map, dataType) => {
        const dataTypeObj = {
            ...dataType.$,
            documentation: parseDocument(dataType.annotation[0].documentation),
        };
        if (dataType["mappedDatatype"]) {
            const mappedDatatype = dataType["mappedDatatype"][0];
            dataTypeObj.pattern = mappedDatatype.$.pattern;
            dataTypeObj.minInclusive = parseInt(mappedDatatype.$.minInclusive);
        }

        map[dataType.$.name] = dataTypeObj;
        return map;
    }, {});
}

function parseFields(repo) {
    return repo["fields"][0]["field"].reduce((map, field) => {
        map[field.$.id] = {
            ...field.$,
            documentation: parseDocument(field.annotation[0].documentation),
        };
        return map;
    }, {});
}

function parseComponents(repo) {
    return repo["components"][0]["component"].reduce((map, component) => {
        map[component.$.id] = {
            ...component.$,
            documentation: parseDocument(component.annotation[0].documentation),
            structures: parseStructure(component.$$),
        };
        return map;
    }, {});
}

function parseGroups(repo) {
    const groups = repo["components"][0]['group'];
    if (!groups) {
        return undefined;
    }
    return groups.reduce((map, group) => {
        map[group.$.id] = {
            ...group.$,
            documentation: typeof group.annotation[0].documentation[0] === "string" ? group.annotation[0].documentation[0] : undefined,
            structures: parseStructure(group.$$),
        };
        return map;
    }, {});
}

function parseMessages(repo) {
    return repo["messages"][0]["message"].reduce((map, message) => {
        map[message.$.msgType] = {
            ...message.$,
            documentation: parseDocument(message.annotation[0].documentation),
            structures: parseStructure(message.structure[0].$$),
        };
        return map;
    }, {});
}


function parseStructure(structure) {
    return structure.filter(node => node["#name"] !== "annotation").reduce((map, node) => {
        map[node.$.id] = {
            ...node.$,
            type: node["#name"],
            presence: undefined,
            required: node.$.presence === "required",
            documentation: typeof node.annotation[0].documentation[0] === "string" ? node.annotation[0].documentation[0] : undefined,
        };
        return map;
    }, {});
}

function parseCodeSets(repo) {
    return repo["codeSets"][0]["codeSet"].reduce((map, codeSet) => {
        map[codeSet.$.name] = {
            ...codeSet.$,
            documentation: parseDocument(codeSet.annotation[0].documentation),
            codes: codeSet.code
                .map(code => {
                    return {
                        ...code.$,
                        sort: parseInt(code.$.sort),
                        documentation: parseDocument(code.annotation[0].documentation)
                }})
                .sort((a, b) => a.sort - b.sort)
                .reduce((codeMap, code) => {
                    codeMap[code.value] = code;
                    return codeMap;
                }, {}),
        };
        return map;
    }, {});
}

function parseDocument(docs) {
    const doc = {};
    docs.filter(docNode => typeof docNode._ === "string").forEach(docNode => {
        doc[docNode.$.purpose.toLowerCase()] = docNode._;
    });
    return Object.keys(doc).length === 0 ? undefined : doc;
}
