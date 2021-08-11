import * as fs from "fs";
import * as path from "path";
import { schema } from "yaml-cfn";
import yaml from "js-yaml";




interface IEntryPointMap {
  [pname: string]: string;
}

interface EntryPoint {
  resourceKey: string;
  inputPath: string;
  outputPath: string;
}

// get rid of ientry and move nested templates into sam template as their own type
interface Stack {
  entryPoints: EntryPoint[];
  templatePath: string;
  templateYml: any;
  templateName: string;
}

interface Cloudformation {
  stack: Stack;
  nestedStacks: Stack[];
}

class AwsSamPlugin {
  private cloudformation: Cloudformation | undefined;
  private inputPath:string = ".";
  private outputPath: string = "./.aws-sam/build";
  private entryPoints: EntryPoint[] = [];
  //private absoluteInputPath:string = "";
  //private absoluteOutputPath:string = "";
  private templatPath: string = "template.yml";
  constructor() {
    //this.absoluteInputPath = path.resolve(this.inputPath);
    //this.absoluteOutputPath = path.resolve(this.outputPath);
    this.cloudformation = undefined;
    this.entryPoints = [];
  }



  private getStack(templatePath: string): Stack {

    const templateYml = yaml.load(fs.readFileSync(templatePath).toString(), { filename: path.basename(templatePath), schema }) as any;

    const defaultRuntime = templateYml.Globals?.Function?.Runtime ?? null;
    const defaultHandler = templateYml.Globals?.Function?.Handler ?? null;
    const defaultCodeUri = templateYml.Globals?.Function?.CodeUri ?? null;
    let entryPoints: EntryPoint[] = [];


    // Loop through all of the resources
    for (const resourceKey in templateYml.Resources) {
      const resource = templateYml.Resources[resourceKey];


      // Correct paths for files that can be uploaded using "aws couldformation package"
      if (resource.Type === "AWS::ApiGateway::RestApi" && typeof resource.Properties.BodyS3Location === "string") {
        templateYml.Resources[resourceKey].Properties.BodyS3Location = path.relative(
          this.inputPath,
          resource.Properties.BodyS3Location
        );
      }
      if (resource.Type === "AWS::Lambda::Function" && typeof resource.Properties.Code === "string") {
        templateYml.Resources[resourceKey].Properties.Code = path.relative(this.inputPath, resource.Properties.Code);
      }
      if (
        resource.Type === "AWS::AppSync::GraphQLSchema" &&
        typeof resource.Properties.DefinitionS3Location === "string" &&
        resource.Properties.DefinitionS3Location.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.DefinitionS3Location = path.relative(
          this.inputPath,
          resource.Properties.DefinitionS3Location
        );
      }
      if (
        resource.Type === "AWS::AppSync::Resolver" &&
        typeof resource.Properties.RequestMappingTemplateS3Location === "string" &&
        resource.Properties.RequestMappingTemplateS3Location.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.RequestMappingTemplateS3Location = path.relative(
          this.inputPath,
          resource.Properties.RequestMappingTemplateS3Location
        );
      }
      if (
        resource.Type === "AWS::AppSync::Resolver" &&
        typeof resource.Properties.ResponseMappingTemplateS3Location === "string" &&
        resource.Properties.ResponseMappingTemplateS3Location.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.ResponseMappingTemplateS3Location = path.relative(
          this.inputPath,
          resource.Properties.ResponseMappingTemplateS3Location
        );
      }
      if (
        resource.Type === "AWS::Serverless::Api" &&
        typeof resource.Properties.DefinitionUri === "string" &&
        resource.Properties.DefinitionUri.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.DefinitionUri = path.relative(
          this.inputPath,
          resource.Properties.DefinitionUri
        );
      }
      if (
        resource.Type === "AWS::Include" &&
        typeof resource.Properties.Location === "string" &&
        resource.Properties.Location.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.Location = path.relative(this.inputPath, resource.Properties.Location);
      }
      if (
        resource.Type === "AWS::ElasticBeanstalk::ApplicationVersion" &&
        typeof resource.Properties.SourceBundle === "string" &&
        resource.Properties.SourceBundle.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.SourceBundle = path.relative(
          this.inputPath,
          resource.Properties.SourceBundle
        );
      }
      if (
        resource.Type === "AWS::CloudFormation::Stack" &&
        typeof resource.Properties.TemplateURL === "string" &&
        resource.Properties.TemplateURL.startsWith("s3://") === false
      ) {

        templateYml.Resources[resourceKey].Properties.TemplateURL = path.relative(
          this.inputPath,
          resource.Properties.TemplateURL
        );
        //console.log(samConfig.Resources[resourceKey].Properties.TemplateURL);
      }
      if (
        resource.Type === "AWS::Glue::Job" &&
        resource.Properties.Command &&
        typeof resource.Properties.Command.ScriptLocation === "string" &&
        resource.Properties.Command.ScriptLocation.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.Command.ScriptLocation = path.relative(
          this.inputPath,
          resource.Properties.Command.ScriptLocation
        );
      }
      if (
        resource.Type === "AWS::StepFunctions::StateMachine" &&
        typeof resource.Properties.DefinitionS3Location === "string" &&
        resource.Properties.DefinitionS3Location.startsWith("s3://") === false
      ) {
        templateYml.Resources[resourceKey].Properties.DefinitionS3Location = path.relative(
          this.inputPath,
          resource.Properties.DefinitionS3Location
        );
      }
      // Find all of the functions
      if (resource.Type === "AWS::Serverless::Function") {
        const properties = resource.Properties;
        if (!properties) {
          throw new Error(`${resourceKey} is missing Properties`);
        }

        // Check the runtime is supported
        if (!["nodejs10.x", "nodejs12.x", "nodejs14.x"].includes(properties.Runtime ?? defaultRuntime)) {
          throw new Error(`${resourceKey} has an unsupport Runtime. Must be nodejs10.x, nodejs12.x or nodejs14.x`);
        }

        // Continue with a warning if they're using inline code
        if (properties.InlineCode) {
          console.log(
            `WARNING: This plugin does not compile inline code. The InlineCode for '${resourceKey}' will be copied 'as is'.`
          );
          continue;
        }

        // Check we have a valid handler
        const handler = properties.Handler ?? defaultHandler;
        if (!handler) {
          throw new Error(`${resourceKey} is missing a Handler`);
        }
        const handlerComponents = handler.split(".");
        if (handlerComponents.length !== 2) {
          throw new Error(`${resourceKey} Handler must contain exactly one "."`);
        }

        // Check we have a CodeUri
        const codeUri = properties.CodeUri ?? defaultCodeUri;
        if (!codeUri) {
          throw new Error(`${resourceKey} is missing a CodeUri`);
        }
        const inputPath = path.resolve(path.join(path.dirname(templatePath), codeUri, handlerComponents[0]));
        const outputPath = path.join(this.outputPath, resourceKey, "index.js");
        entryPoints.push({ resourceKey: resourceKey, inputPath: inputPath, outputPath: outputPath });
        templateYml.Resources[resourceKey].Properties.CodeUri = path.relative(path.dirname(templatePath),path.join(this.inputPath,resourceKey));
        templateYml.Resources[resourceKey].Properties.Handler = `index.${handlerComponents[1]}`;
      }
    }
    //console.log("Entry Points");
    //console.log(entryPoints);
    return { entryPoints: entryPoints, templatePath: templatePath, templateName: path.basename(templatePath), templateYml: templateYml }
  }

  public getCloudformation(): Cloudformation {

    let nestedStacks: Stack[] = [];
    //console.log(this.templatPath);
    const templateYml = yaml.load(fs.readFileSync(this.templatPath).toString(), { filename: path.basename(this.templatPath), schema }) as any;

    for (const resourceKey in templateYml.Resources) {
      const resource = templateYml.Resources[resourceKey];
      if (
        resource.Type === "AWS::CloudFormation::Stack" &&
        typeof resource.Properties.TemplateURL === "string" &&
        resource.Properties.TemplateURL.startsWith("s3://") === false
      ) {
        fs.readFileSync(resource.Properties.TemplateURL);
        nestedStacks.push(this.getStack(resource.Properties.TemplateURL));
      }
    }
    return { stack: this.getStack(this.templatPath), nestedStacks: nestedStacks };
  }

  private getEntryPointMap(cloudformation: Cloudformation): IEntryPointMap {
    let entryPoints: IEntryPointMap = {}

    cloudformation.nestedStacks.forEach((stack: Stack) => {
      stack.entryPoints.forEach((entryPoint: EntryPoint) => {
        this.entryPoints.push(entryPoint);
        entryPoints[entryPoint.resourceKey] = entryPoint.inputPath;
      });
    });
    cloudformation.stack.entryPoints.forEach((entryPoint: EntryPoint) => {
      this.entryPoints.push(entryPoint);
      entryPoints[entryPoint.resourceKey] = entryPoint.inputPath;
    });
    return entryPoints;
  }

  public entry(): IEntryPointMap {
    const cloudformation: Cloudformation = this.getCloudformation();
    this.cloudformation = cloudformation;
    return this.getEntryPointMap(cloudformation);
  }

  public filename(chunkData: any) {
    const entryPoint: EntryPoint | undefined = this.entryPoints.find((entryPoint: EntryPoint) => entryPoint.resourceKey === chunkData.chunk.name);
    if (!entryPoint) {
      throw new Error(`Unable to find entryPoint for ${chunkData.chunk.name}`);
    }
    //console.log(chunkData);
    return entryPoint.outputPath;
  }



  private writeTemplateFile(stack: Stack) {
    const templatePath = path.resolve(path.join(this.outputPath, stack.templatePath));
    if (!fs.existsSync(path.dirname(templatePath))) {
       fs.promises.mkdir(path.dirname(templatePath), { recursive: true }).catch((err) => {
        throw new Error(err);
      }).finally(() =>{
        fs.writeFileSync(
          templatePath,
          yaml.dump(stack.templateYml, { indent: 2, quotingType: '"', schema })
        );
      });
      
    } else {
      fs.writeFileSync(
        templatePath,
        yaml.dump(stack.templateYml, { indent: 2, quotingType: '"', schema })
      );
    }
  }

  public apply(compiler: any) {
    compiler.hooks.afterEmit.tap("SamPlugin", (_compilation: any) => {
      this.cloudformation?.nestedStacks.forEach((stack: Stack) => {
        this.writeTemplateFile(stack);
        console.log("write nested: " + path.resolve(path.join(this.outputPath, stack.templatePath)));
      });
      if (this.cloudformation && this.cloudformation.stack) {
        console.log("write main: " + path.resolve(path.join(this.outputPath, this.cloudformation?.stack.templatePath)));
        this.writeTemplateFile(this.cloudformation?.stack);
      } else {
        throw new Error("No cloudformation stack object created");
      }
    });
  }
}

export = AwsSamPlugin;
