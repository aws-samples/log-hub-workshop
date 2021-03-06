/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */
import {readFileSync} from 'fs';
import * as path from 'path'

import * as au from '@aws-cdk/aws-autoscaling';
import * as cdk from '@aws-cdk/core';
import * as cdn from '@aws-cdk/aws-cloudfront';
import * as origins from '@aws-cdk/aws-cloudfront-origins';
import * as ec2 from '@aws-cdk/aws-ec2' // import ec2 library 
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2' // import elb2 library
import * as rds from '@aws-cdk/aws-rds';
import * as iam from '@aws-cdk/aws-iam';
import * as s3 from '@aws-cdk/aws-s3';
import * as s3d from '@aws-cdk/aws-s3-deployment';
import * as opensearch from "@aws-cdk/aws-opensearchservice";
import { OriginAccessIdentity } from '@aws-cdk/aws-cloudfront';

import { LogFakerStack, LogFakerProps } from './log-faker';

const workshopDB_user = 'admin';
const workshopDB_secretName = 'workshopDBSecret'
const workshopDB_name = 'workshopDB';
const workshopOpensearch_name = 'workshop-os';
const workshopOpensearch_username = 'admin';
const workshopOpensearch_password = cdk.SecretValue.plainText('Loghub@@123');

export class MainStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // upload workshop simple app to s3.
    const webSiteS3 = new s3.Bucket(this, 'loghubWorkshopWebsite', {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // upload static images to s3, will be exposed through cdn.
    new s3d.BucketDeployment(this, 'DeployWebAssets', {
      sources: [s3d.Source.asset(path.join(__dirname, '../s3'))],
      destinationBucket: webSiteS3,
      destinationKeyPrefix: 'assets',
      prune: false,
    });
    const oai = new OriginAccessIdentity(this, 'OAI');
    const cloudFrontToS3 = new cdn.Distribution(this, 'CDNWorkshopAssets', {
      defaultBehavior: {
        origin: new origins.S3Origin(webSiteS3, {
          originPath: 'assets',
          originAccessIdentity: oai
        }),
      },
      minimumProtocolVersion: cdn.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: true,
      logBucket: webSiteS3,
      logFilePrefix: 'distribution-access-logs/',
      comment: 'LogHub-Workshop Assets'
    });
    webSiteS3.grantRead(oai)

    // upload simple web page to s3
    const simpleAppUpload = new s3d.BucketDeployment(this, 'DeployWorkshopWebSite', {
      sources: [
        s3d.Source.asset(path.join(__dirname, '../simple-app'), { exclude: ['node_modules']})
      ],
      destinationBucket: webSiteS3,
      prune: false,
    });

    // VPC
    const workshopVpc = new ec2.Vpc(this, 'workshopVpc', {
      maxAzs: 2,
      natGateways: 1,
      cidr: '10.0.0.0/16',
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        }
      ]
    });

    // Log Faker
    const logFakerProps: LogFakerProps = {
        logBucketName: webSiteS3.bucketName,
        logBucketPrefix: 'distribution-access-logs/',
    }
    const logFaker = new LogFakerStack(this, 'logFakerStack', logFakerProps)

    // RDS
    // 1. create a secret manager first.
    const rdsSecret = new rds.DatabaseSecret(
      this,
      'rdsSecret',
      {
          username: workshopDB_user,
          secretName: workshopDB_secretName
      }
    );

    // 2. security group
    const dbSecurityGroup = new ec2.SecurityGroup(this, "workshopDBSecurityGroup", {
      vpc: workshopVpc,
      
    })

    // 3. create DB using the secret
    const dbEngine = rds.DatabaseInstanceEngine.mysql({
      version: rds.MysqlEngineVersion.VER_8_0_25
    });
    const workshopDB = new rds.DatabaseInstance(this, 'workshopDB', {
      instanceIdentifier: 'workshop-db',
      engine: dbEngine,
      vpc: workshopVpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.MICRO),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      databaseName: workshopDB_name,
      backupRetention: cdk.Duration.days(0),
      credentials: rds.Credentials.fromSecret(rdsSecret, workshopDB_user),
      publiclyAccessible: false,
      securityGroups: [dbSecurityGroup],
      parameterGroup: new rds.ParameterGroup(this, 'parameterGroup', {
        engine: dbEngine,
        parameters: {
          slow_query_log: '1',
          long_query_time: '1',
          log_output: 'FILE'
        }
      }),
      optionGroup: new rds.OptionGroup(this, 'optionGroup', {
        engine: dbEngine,
        configurations: [{
          name: 'MARIADB_AUDIT_PLUGIN',
        }]
      }),
      cloudwatchLogsExports: ['error', 'slowquery', 'audit']
    });

    // ASG
    const workshopASG = new au.AutoScalingGroup(this, 'workshopASG', {
      instanceType: new ec2.InstanceType("t2.small"),
      vpc: workshopVpc,
      machineImage: new ec2.AmazonLinuxImage({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      desiredCapacity: 2,
      minCapacity: 2,
      maxCapacity: 2,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        onePerAz: true
      },
      updatePolicy: au.UpdatePolicy.rollingUpdate()
    });
    workshopASG.node.addDependency(workshopDB);
    workshopASG.node.addDependency(cloudFrontToS3);
    workshopASG.node.addDependency(simpleAppUpload);
    workshopASG.node.addDependency(logFaker);
    workshopASG.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    workshopASG.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'));
    workshopASG.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'));
    workshopASG.addUserData(readFileSync('./lib/user-data.sh', 'utf8'));
    workshopASG.userData.addS3DownloadCommand({
      bucket: webSiteS3,
      bucketKey: 'nginx.config',
      localFile: '/etc/nginx/nginx.conf'
    });
    const mergeScript = `var a  = JSON.parse(require("/var/www/inc/dbinfo.json"));\
    var b = require("/var/www/server/ormconfig.json");\
    var output = Object.assign({}, b, a);\
    output.database = a.dbname;\
    var fs = require("fs");\
    fs.writeFile("/var/www/server/ormconfig.json", JSON.stringify(output), function(err){});`;
    workshopASG.userData.addCommands(
      `echo '${workshopDB.instanceIdentifier}'`,
      `aws s3 cp '${webSiteS3.s3UrlForObject('ui')}' '/var/www/ui' --recursive`,
      `aws s3 cp '${webSiteS3.s3UrlForObject('server')}' '/var/www/server' --recursive`,
      `echo $(aws secretsmanager get-secret-value --secret-id ${workshopDB_secretName} --query SecretString --output json --region ${this.region}) > /var/www/inc/dbinfo.json`,
      `echo '${mergeScript}' > mergeDBInfo.js`,
      'node mergeDBInfo.js',
      'cd /var/www/ui',
      'npm install && npm run build',
      'yes | cp -r /var/www/ui/build/* /usr/share/nginx/html/',
      'chkconfig nginx on',
      'service nginx start',
      'service nginx restart',
      `sed -i 's/$WORKSHOP_CDN_DOMAIN/${cloudFrontToS3.domainName}/' /var/www/server/src/controllers/mockdata.ts`,
      `sed -i 's/daily/monthly/' /etc/logrotate.d/nginx`,
      `echo "{\\"fakerAPIUrl\\":\\"${logFaker.fakerApiUrl}\\"}" > /usr/share/nginx/html/config.json`,
      'cd /var/www/server',
      'npm install && npm run start'
    );

    // ELB
    const workshopAlb = new elbv2.ApplicationLoadBalancer(this, 'workshopAlb', {
      vpc: workshopVpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      }
    });

    const listener = workshopAlb.addListener('Listener', {
      port: 80
    });

    listener.addTargets('ApplicationFleet', {
      port: 80,
      targets: [workshopASG]
    });

    // Connections
    dbSecurityGroup.connections.allowFrom(workshopASG, ec2.Port.tcp(3306));
    dbSecurityGroup.connections.allowFrom(workshopASG, ec2.Port.tcp(22));

    // Open Search
    const workshopOpensearch = new opensearch.Domain(this, 'workshopOpensearch', {
      domainName: workshopOpensearch_name,
      version: opensearch.EngineVersion.OPENSEARCH_1_0,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      vpc: workshopVpc,
      vpcSubnets: [workshopVpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_NAT, availabilityZones: [workshopVpc.availabilityZones[0]]})],
      capacity: {
        dataNodes: 2,
        dataNodeInstanceType: 'r6g.xlarge.search',
      },
      nodeToNodeEncryption: true,
      encryptionAtRest: {
        enabled: true
      },
      enforceHttps: true,
      fineGrainedAccessControl: {
        masterUserName: workshopOpensearch_username,
        masterUserPassword: workshopOpensearch_password
      },
      accessPolicies: [new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['es:*'],
        principals: [
          new iam.AnyPrincipal
        ],
        resources: [
          `arn:aws:es:${this.region}:${this.account}:domain/${workshopOpensearch_name}/*`
        ]
      })]
    });
    workshopOpensearch.connections.allowFromAnyIpv4(ec2.Port.tcp(443));
    
    // Outputs
    new cdk.CfnOutput(this, 'Region', { value: this.region })
    new cdk.CfnOutput(this, 'ALB CNAME', { value: workshopAlb.loadBalancerDnsName })
    new cdk.CfnOutput(this, 'dbEndpoint', { value: workshopDB.instanceEndpoint.hostname });

    new cdk.CfnOutput(this, 's3Bucket', {
      value: webSiteS3.bucketArn,
    });
    new cdk.CfnOutput(this, 'opensearchDomain', {
      value: workshopOpensearch.domainEndpoint
    });
    new cdk.CfnOutput(this, 'cloudFront', {
      value: cloudFrontToS3.domainName
    });
    new cdk.CfnOutput(this, 'fakerAPIURL', {
      value: logFaker.fakerApiUrl
    })
  }
}